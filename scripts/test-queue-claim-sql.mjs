/**
 * Runs the same claim SELECT as production inside BEGIN…ROLLBACK (no durable mutation).
 *
 *   npm run test-queue-claim-sql
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

const CLAIM_ES_JW_J = `COALESCE(
  NULLIF(TRIM(jw.signer_address), ''),
  NULLIF(TRIM(j.signer_address), ''),
  NULLIF(TRIM(j.signer_addresses_json #>> '{0}'), '')
)`;
const CLAIM_ES_PX_JP = `COALESCE(
  NULLIF(TRIM(px.signer_address), ''),
  NULLIF(TRIM(jp.signer_address), ''),
  NULLIF(TRIM(jp.signer_addresses_json #>> '{0}'), '')
)`;

const url = process.env.DATABASE_URL?.trim();
if (!url || !/^postgres(ql)?:\/\//i.test(url)) {
  console.error("DATABASE_URL must be postgresql://…");
  process.exit(1);
}

function envInt(name, fallback, min, max) {
  const n = parseInt(process.env[name]?.trim() ?? "", 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
const batch = envInt("AIRDROP_QUEUE_BATCH_SIZE", 48, 1, 500);
const maxRetries = envInt("AIRDROP_QUEUE_MAX_RETRIES", 5, 0, 100);
const maxAttempts = maxRetries + 1;

const CLAIM_JOB_ELIGIBLE_WHERE = `(j.paused IS NOT TRUE AND j.status IN ('queued', 'running', 'processing'))`;
const CLAIM_WALLET_ORDER_BY_JW_J = `md5(jw.job_id::text || ':' || jw.id::text), j.queued_at ASC NULLS LAST, j.id, jw.id`;

const CLAIM_SQL = `SELECT DISTINCT ON (lower(trim(${CLAIM_ES_JW_J})))
   jw.id AS id, jw.job_id AS "jobId"
   FROM job_wallets jw
   INNER JOIN jobs j ON j.id = jw.job_id
   WHERE jw.status = 'pending'
     AND (jw.next_attempt_at IS NULL OR jw.next_attempt_at <= NOW())
     AND jw.retry_count < $1
     AND (${CLAIM_JOB_ELIGIBLE_WHERE})
     AND (${CLAIM_ES_JW_J}) IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM job_wallets px
       INNER JOIN jobs jp ON jp.id = px.job_id
       WHERE px.status = 'processing'
         AND lower(trim(${CLAIM_ES_PX_JP})) = lower(trim(${CLAIM_ES_JW_J}))
     )
   ORDER BY lower(trim(${CLAIM_ES_JW_J})), ${CLAIM_WALLET_ORDER_BY_JW_J}
   LIMIT $2
   FOR UPDATE OF jw SKIP LOCKED`;

async function main() {
  const pool = new pg.Pool({ connectionString: url, max: 2 });
  const c = await pool.connect();
  try {
    const jobs = await c.query(
      `SELECT COUNT(DISTINCT j.id)::text AS c
       FROM jobs j
       INNER JOIN job_wallets jw ON jw.job_id = j.id
       WHERE jw.status = 'pending'
         AND (${CLAIM_JOB_ELIGIBLE_WHERE})`,
    );
    const simple = await c.query(
      `SELECT COUNT(*)::text AS c FROM job_wallets WHERE status = 'pending'
       AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())`,
    );

    await c.query("BEGIN");
    const sel = await c.query(CLAIM_SQL, [maxAttempts, batch]);
    await c.query("ROLLBACK");

    console.log(
      JSON.stringify(
        {
          event: "test_queue_claim_sql",
          candidateDistinctJobsApprox: Number(jobs.rows[0]?.c ?? 0),
          claimablePendingSimple: Number(simple.rows[0]?.c ?? 0),
          claimSelectReturnedRows: sel.rowCount ?? sel.rows.length,
          firstWalletIds: sel.rows.slice(0, 12).map((r) => r.id),
          batchLimit: batch,
          maxAttempts,
        },
        null,
        2,
      ),
    );
  } catch (e) {
    try {
      await c.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    console.error(JSON.stringify({ event: "test_queue_claim_sql_error", message: String(e), stack: e?.stack }));
    throw e;
  } finally {
    c.release();
    await pool.end();
  }
}

main().catch(() => process.exit(1));
