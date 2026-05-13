/**
 * Deterministic claim debugger for a single job_id (must match production claim SQL semantics).
 *
 *   node scripts/debug-one-job-claim.mjs <job_id>
 *   node scripts/debug-one-job-claim.mjs <job_id> --force-one
 *
 * Uses columns: assigned_worker (not claimed_by), retry_count, error_message, next_attempt_at.
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import pg from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
dotenv.config({ path: join(root, ".env") });
const require = createRequire(import.meta.url);
require(join(root, "database-url.js")).ensureDatabaseUrl();

const url = process.env.DATABASE_URL?.trim();
if (!url || !/^postgres(ql)?:\/\//i.test(url)) {
  console.error("DATABASE_URL must be postgresql://…");
  process.exit(1);
}

const args = process.argv.slice(2);
const forceOne = args.includes("--force-one");
const uuidLike = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s ?? ""));
const jobId =
  args.filter((a) => !a.startsWith("--")).find((a) => uuidLike(a)) ??
  args.find((a) => !a.startsWith("--"))?.trim();
if (!jobId) {
  console.error("Usage: node scripts/debug-one-job-claim.mjs <job_id> [--force-one]");
  process.exit(1);
}

function envInt(name, fallback, min, max) {
  const n = parseInt(process.env[name]?.trim() ?? "", 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
const maxRetries = envInt("AIRDROP_QUEUE_MAX_RETRIES", 5, 0, 100);
const maxAttempts = maxRetries + 1;

const ES_JW_J = `COALESCE(
  NULLIF(TRIM(jw.signer_address), ''),
  NULLIF(TRIM(j.signer_address), ''),
  NULLIF(TRIM(j.signer_addresses_json #>> '{0}'), '')
)`;
const ES_PX_JP = `COALESCE(
  NULLIF(TRIM(px.signer_address), ''),
  NULLIF(TRIM(jp.signer_address), ''),
  NULLIF(TRIM(jp.signer_addresses_json #>> '{0}'), '')
)`;
const CLAIM_JOB_ELIGIBLE = `(j.paused IS NOT TRUE AND j.status IN ('queued', 'running', 'processing'))`;
const BACKFILL = `COALESCE(
  NULLIF(TRIM(jw.signer_address), ''),
  NULLIF(TRIM(j.signer_address), ''),
  NULLIF(TRIM(j.signer_addresses_json #>> '{0}'), '')
)`;

const CANDIDATE_BODY = `
SELECT DISTINCT ON (lower(trim(${ES_JW_J})))
  jw.id AS id
FROM job_wallets jw
INNER JOIN jobs j ON j.id = jw.job_id
WHERE jw.job_id = $1
  AND jw.status = 'pending'
  AND (jw.next_attempt_at IS NULL OR jw.next_attempt_at <= NOW())
  AND jw.retry_count < $2
  AND (${CLAIM_JOB_ELIGIBLE})
  AND (${ES_JW_J}) IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM job_wallets px
    INNER JOIN jobs jp ON jp.id = px.job_id
    WHERE px.status = 'processing'
      AND lower(trim(${ES_PX_JP})) = lower(trim(${ES_JW_J}))
  )
ORDER BY lower(trim(${ES_JW_J})), md5(jw.job_id::text || ':' || jw.id::text), j.queued_at ASC NULLS LAST, j.id, jw.id`;

const CANDIDATE_SQL = `${CANDIDATE_BODY}
LIMIT 20`;

/** Same clause order as production {@link claimWalletBatch}: FOR UPDATE before LIMIT. */
const FORCE_ONE_SELECT_SQL = `${CANDIDATE_BODY}
FOR UPDATE OF jw SKIP LOCKED
LIMIT 1`;

async function explainBlockers(pool, jid) {
  const checklist = {
    job_status_not_accepted_by_claim_sql: false,
    job_paused: false,
    wallet_status_not_pending: false,
    signer_missing_effective: false,
    same_signer_has_processing_row: false,
    next_attempt_at_future: false,
    max_attempts_exceeded: false,
    claim_sql_column_name_mismatch: false,
    claim_sql_assigned_worker_filter: false,
    normalized_queue_v2_or_processing_flag: false,
  };

  let rt = null;
  try {
    const r = await pool.query(
      `SELECT processing_enabled, normalized_queue_v2 FROM queue_runtime_settings WHERE id = 1`,
    );
    rt = r.rows[0] ?? null;
    if (rt && (rt.processing_enabled === false || rt.normalized_queue_v2 === false)) {
      checklist.normalized_queue_v2_or_processing_flag = true;
    }
  } catch {
    /* table missing — ignore */
  }

  let colHints = { job_wallets: [] };
  try {
    const c = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'job_wallets'
       ORDER BY ordinal_position`,
    );
    colHints.job_wallets = c.rows.map((r) => r.column_name);
    if (!colHints.job_wallets.includes("retry_count") && colHints.job_wallets.includes("attempt_count")) {
      checklist.claim_sql_column_name_mismatch = true;
    }
  } catch {
    /* ignore */
  }

  const j = await pool.query(`SELECT id, status, paused FROM jobs WHERE id = $1`, [jid]);
  if (j.rows.length === 0) {
    console.log(JSON.stringify({ reason: "job row missing", job_id: jid, checklist }, null, 2));
    return;
  }
  const row = j.rows[0];
  const reasons = [];
  if (row.paused === true) {
    checklist.job_paused = true;
    reasons.push("[job_paused] job.paused is TRUE — claim SQL requires paused IS NOT TRUE");
  }
  if (!["queued", "running", "processing"].includes(String(row.status))) {
    checklist.job_status_not_accepted_by_claim_sql = true;
    reasons.push(
      `[job_status_not_accepted_by_claim_sql] job.status '${row.status}' not in ('queued','running','processing')`,
    );
  }

  const pend = await pool.query(
    `SELECT COUNT(*)::int AS c FROM job_wallets WHERE job_id = $1 AND status = 'pending'`,
    [jid],
  );
  if (Number(pend.rows[0]?.c) === 0) {
    checklist.wallet_status_not_pending = true;
    reasons.push("[wallet_status_not_pending] no rows with status='pending' for this job_id");
  }

  const noSigner = await pool.query(
    `SELECT COUNT(*)::int AS c
     FROM job_wallets jw
     INNER JOIN jobs j ON j.id = jw.job_id
     WHERE jw.job_id = $1 AND jw.status = 'pending'
       AND (${ES_JW_J}) IS NULL`,
    [jid],
  );
  if (Number(noSigner.rows[0]?.c) > 0) {
    checklist.signer_missing_effective = true;
    reasons.push(
      `[signer_missing_effective] ${noSigner.rows[0].c} pending row(s): COALESCE(jw.signer_address, j.signer_address, signer_addresses_json[0]) is NULL/empty`,
    );
  }

  const backoff = await pool.query(
    `SELECT COUNT(*)::int AS c FROM job_wallets WHERE job_id = $1 AND status = 'pending'
     AND next_attempt_at IS NOT NULL AND next_attempt_at > NOW()`,
    [jid],
  );
  if (Number(backoff.rows[0]?.c) > 0) {
    checklist.next_attempt_at_future = true;
    reasons.push(`[next_attempt_at_future] ${backoff.rows[0].c} pending row(s) with next_attempt_at > NOW()`);
  }

  const cap = await pool.query(
    `SELECT COUNT(*)::int AS c FROM job_wallets WHERE job_id = $1 AND status = 'pending' AND retry_count >= $2`,
    [jid, maxAttempts],
  );
  if (Number(cap.rows[0]?.c) > 0) {
    checklist.max_attempts_exceeded = true;
    reasons.push(`[max_attempts_exceeded] ${cap.rows[0].c} pending row(s) with retry_count >= maxAttempts (${maxAttempts})`);
  }

  const blockedSigner = await pool.query(
    `SELECT COUNT(*)::int AS c
     FROM job_wallets jw
     INNER JOIN jobs j ON j.id = jw.job_id
     WHERE jw.job_id = $1 AND jw.status = 'pending'
       AND (${ES_JW_J}) IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM job_wallets px
         INNER JOIN jobs jp ON jp.id = px.job_id
         WHERE px.status = 'processing'
           AND lower(trim(${ES_PX_JP})) = lower(trim(${ES_JW_J}))
       )`,
    [jid],
  );
  if (Number(blockedSigner.rows[0]?.c) > 0) {
    checklist.same_signer_has_processing_row = true;
    reasons.push(
      `[same_signer_has_processing_row] ${blockedSigner.rows[0].c} pending row(s): NOT EXISTS fails — another row is processing with same effective signer (globally)`,
    );
  }

  reasons.push(
    "[claim_sql_assigned_worker_filter] production claim SELECT does not filter on assigned_worker; only status/signer/job gates apply",
  );

  console.log(
    JSON.stringify(
      {
        event: "force_one_zero_reasons",
        job_id: jid,
        job: row,
        queue_runtime_settings_row_1: rt,
        information_schema_job_wallets_columns_sample: colHints.job_wallets.slice(0, 40),
        checklist,
        reasons,
        note: "If checklist is all false but candidates>0 elsewhere, suspect SKIP LOCKED contention, worker early-exit (queue V2 / global pause / processing_enabled), or DISTINCT ON starvation vs other jobs.",
      },
      null,
      2,
    ),
  );
}

async function main() {
  const pool = new pg.Pool({ connectionString: url, max: 3 });
  try {
    console.log("\n=== (1) jobs row ===\n");
    const job = await pool.query(`SELECT * FROM jobs WHERE id = $1`, [jobId]);
    console.log(JSON.stringify(job.rows, null, 2));

    console.log("\n=== (2) first 20 job_wallets ===\n");
    const w = await pool.query(
      `SELECT * FROM job_wallets WHERE job_id = $1 ORDER BY id ASC LIMIT 20`,
      [jobId],
    );
    console.log(JSON.stringify(w.rows, null, 2));

    console.log("\n=== (3) information_schema.columns ===\n");
    const cols = await pool.query(
      `SELECT table_name, column_name, data_type
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name IN ('jobs', 'job_wallets')
       ORDER BY table_name, ordinal_position`,
    );
    console.log(JSON.stringify(cols.rows, null, 2));

    console.log("\n=== (4) counts ===\n");
    const q = async (label, sql, params = [jobId]) => {
      const r = await pool.query(sql, params);
      console.log(label, r.rows[0]);
    };
    await q("total_wallets", `SELECT COUNT(*)::text AS c FROM job_wallets WHERE job_id = $1`);
    await q("pending", `SELECT COUNT(*)::text AS c FROM job_wallets WHERE job_id = $1 AND status = 'pending'`);
    await q("processing", `SELECT COUNT(*)::text AS c FROM job_wallets WHERE job_id = $1 AND status = 'processing'`);
    await q("completed", `SELECT COUNT(*)::text AS c FROM job_wallets WHERE job_id = $1 AND status = 'completed'`);
    await q("failed", `SELECT COUNT(*)::text AS c FROM job_wallets WHERE job_id = $1 AND status = 'failed'`);
    await q(
      "pending signer_address IS NULL",
      `SELECT COUNT(*)::text AS c FROM job_wallets WHERE job_id = $1 AND status = 'pending' AND signer_address IS NULL`,
    );
    await q(
      "pending signer_address IS NOT NULL",
      `SELECT COUNT(*)::text AS c FROM job_wallets WHERE job_id = $1 AND status = 'pending' AND signer_address IS NOT NULL`,
    );
    await q(
      "pending retry/next_attempt ok",
      `SELECT COUNT(*)::text AS c FROM job_wallets WHERE job_id = $1 AND status = 'pending'
       AND (next_attempt_at IS NULL OR next_attempt_at <= NOW()) AND retry_count < $2`,
      [jobId, maxAttempts],
    );
    await q(
      "pending blocked by global processing same signer",
      `SELECT COUNT(*)::text AS c
       FROM job_wallets jw
       INNER JOIN jobs j ON j.id = jw.job_id
       WHERE jw.job_id = $1 AND jw.status = 'pending'
         AND (${ES_JW_J}) IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM job_wallets px
           INNER JOIN jobs jp ON jp.id = px.job_id
           WHERE px.status = 'processing'
             AND lower(trim(${ES_PX_JP})) = lower(trim(${ES_JW_J}))
         )`,
      [jobId],
    );
    await q(
      "pending claimable by real claim filters (this job only)",
      `SELECT COUNT(*)::text AS c FROM (
         SELECT DISTINCT ON (lower(trim(${ES_JW_J}))) jw.id
         FROM job_wallets jw
         INNER JOIN jobs j ON j.id = jw.job_id
         WHERE jw.job_id = $1
           AND jw.status = 'pending'
           AND (jw.next_attempt_at IS NULL OR jw.next_attempt_at <= NOW())
           AND jw.retry_count < $2
           AND (${CLAIM_JOB_ELIGIBLE})
           AND (${ES_JW_J}) IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM job_wallets px
             INNER JOIN jobs jp ON jp.id = px.job_id
             WHERE px.status = 'processing'
               AND lower(trim(${ES_PX_JP})) = lower(trim(${ES_JW_J}))
           )
         ORDER BY lower(trim(${ES_JW_J})), md5(jw.job_id::text || ':' || jw.id::text), j.queued_at ASC NULLS LAST, j.id, jw.id
       ) x`,
      [jobId, maxAttempts],
    );

    try {
      const rt = await pool.query(
        `SELECT processing_enabled, normalized_queue_v2 FROM queue_runtime_settings WHERE id = 1`,
      );
      console.log("\n=== (4b) queue_runtime_settings id=1 (worker gates; not part of SQL claim) ===\n");
      console.log(JSON.stringify(rt.rows, null, 2));
    } catch {
      console.log("\n=== (4b) queue_runtime_settings — (query failed or table missing) ===\n");
    }

    console.log("\n=== (5) first 20 candidate wallet ids (claim-shaped, this job only) ===\n");
    const cand = await pool.query(CANDIDATE_SQL, [jobId, maxAttempts]);
    console.log(JSON.stringify({ ids: cand.rows.map((r) => r.id), count: cand.rows.length }, null, 2));

    if (forceOne) {
      console.log("\n=== (6) FORCE ONE — BEGIN / lock / update / read / reset / COMMIT ===\n");
      const c = await pool.connect();
      const dbg = "debug-one-job-claim".slice(0, 64);
      try {
        await c.query("BEGIN");
        const sel = await c.query(FORCE_ONE_SELECT_SQL, [jobId, maxAttempts]);
        if (sel.rows.length === 0) {
          await c.query("ROLLBACK");
          console.log(JSON.stringify({ event: "force_one_no_row_selected", note: "See reasons below." }, null, 2));
          await explainBlockers(pool, jobId);
        } else {
          const id = sel.rows[0].id;
          await c.query(
            `UPDATE job_wallets jw
             SET status = 'processing',
                 assigned_worker = $1,
                 updated_at = NOW(),
                 signer_address = ${BACKFILL}
             FROM jobs j
             WHERE j.id = jw.job_id AND jw.id = $2`,
            [dbg, id],
          );
          const mid = await c.query(`SELECT id, job_id, status, assigned_worker, signer_address FROM job_wallets WHERE id = $1`, [id]);
          console.log("after update:", JSON.stringify(mid.rows, null, 2));
          await c.query(
            `UPDATE job_wallets SET status = 'pending', assigned_worker = NULL, updated_at = NOW() WHERE id = $1`,
            [id],
          );
          const after = await c.query(`SELECT id, job_id, status, assigned_worker FROM job_wallets WHERE id = $1`, [id]);
          console.log("after reset:", JSON.stringify(after.rows, null, 2));
          await c.query("COMMIT");
          console.log(JSON.stringify({ event: "force_one_ok", wallet_id: id }, null, 2));
        }
      } catch (e) {
        try {
          await c.query("ROLLBACK");
        } catch {
          /* ignore */
        }
        console.error(JSON.stringify({ event: "force_one_sql_error", message: String(e), stack: e?.stack }, null, 2));
        throw e;
      } finally {
        c.release();
      }
    }
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
