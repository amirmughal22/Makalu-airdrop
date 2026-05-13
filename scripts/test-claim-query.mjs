/**
 * Smoke-test queue claim: two-stage SELECT (DISTINCT in subquery only) + optional UPDATE, then ROLLBACK.
 * Mirrors production {@link claimWalletBatch} SQL shape (PostgreSQL).
 *
 *   npm run test:claim-query
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
const CLAIM_JOB_ELIGIBLE_WHERE = `(j.paused IS NOT TRUE AND j.status IN ('queued', 'running', 'processing'))`;
const CLAIM_WALLET_ORDER_BY_JW_J = `md5(jw.job_id::text || ':' || jw.id::text), j.queued_at ASC NULLS LAST, j.id, jw.id`;
const CLAIM_BACKFILL = `COALESCE(
  NULLIF(TRIM(jw.signer_address), ''),
  NULLIF(TRIM(j.signer_address), ''),
  NULLIF(TRIM(j.signer_addresses_json #>> '{0}'), '')
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

const CLAIM_PICK_SUB = `SELECT DISTINCT ON (lower(trim(${CLAIM_ES_JW_J})))
       jw.id AS id, jw.job_id AS "jobId", jw.wallet_address AS "walletAddress", jw.amount AS amount,
              jw.retry_count AS "retryCount", (${CLAIM_ES_JW_J}) AS "signerAddress",
              j.owner AS owner, j.mode AS mode, j.token_address AS "tokenAddress", j.chain_id AS "chainId"
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
       LIMIT $2`;

const CLAIM_LOCK_SQL = `SELECT picked.id AS id, picked."jobId" AS "jobId", picked."walletAddress" AS "walletAddress",
       picked.amount AS amount, picked."retryCount" AS "retryCount", picked."signerAddress" AS "signerAddress",
       picked.owner AS owner, picked.mode AS mode, picked."tokenAddress" AS "tokenAddress", picked."chainId" AS "chainId"
       FROM (${CLAIM_PICK_SUB}) picked
       INNER JOIN job_wallets jw ON jw.id = picked.id
       INNER JOIN jobs j ON j.id = jw.job_id
       FOR UPDATE OF jw SKIP LOCKED`;

function assertNoRootDistinctForUpdate(sql) {
  const t = sql.trimStart();
  if (!/\bFOR\s+UPDATE\b/i.test(sql)) return;
  if (/^\s*SELECT\s+DISTINCT\b/im.test(t)) {
    throw new Error("Root SELECT DISTINCT … FOR UPDATE is invalid (PostgreSQL).");
  }
}

async function main() {
  assertNoRootDistinctForUpdate(CLAIM_LOCK_SQL);

  const pool = new pg.Pool({ connectionString: url, max: 2 });
  const workerId = "test-claim-query".slice(0, 64);
  const c = await pool.connect();
  try {
    await c.query("BEGIN");

    const pickOnly = await c.query(`SELECT * FROM (${CLAIM_PICK_SUB}) c`, [maxAttempts, batch]);

    const sel = await c.query(CLAIM_LOCK_SQL, [maxAttempts, batch]);
    const rows = sel.rows;

    let updateCount = 0;
    if (rows.length > 0) {
      const ids = rows.map((r) => Number(r.id));
      const ph = ids.map((_, i) => `$${i + 2}`).join(", ");
      const upd = await c.query(
        `UPDATE job_wallets jw
         SET status = 'processing',
             assigned_worker = $1,
             updated_at = NOW(),
             signer_address = ${CLAIM_BACKFILL}
         FROM jobs j
         WHERE j.id = jw.job_id AND jw.id IN (${ph})`,
        [workerId, ...ids],
      );
      updateCount = upd.rowCount ?? 0;
    }

    await c.query("ROLLBACK");

    console.log(
      JSON.stringify(
        {
          event: "test_claim_query",
          candidateSelectRowCount: pickOnly.rowCount ?? pickOnly.rows.length,
          twoStageSelectRowCount: rows.length,
          updateRowCountBeforeRollback: updateCount,
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
    console.error(JSON.stringify({ event: "test_claim_query_error", message: String(e), stack: e?.stack }, null, 2));
    throw e;
  } finally {
    c.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
