/**
 * Measures SELECT … FOR UPDATE SKIP LOCKED (claim-shaped query) inside a transaction that rolls back,
 * so rows are not left in `processing`. PostgreSQL.
 *
 *   node --env-file=.env scripts/bench-queue-claim.mjs
 *
 * Env: DATABASE_URL (postgresql://…), optional AIRDROP_QUEUE_BATCH_SIZE (default 48), AIRDROP_QUEUE_MAX_RETRIES (default 5).
 */
import pg from "pg";

const url = process.env.DATABASE_URL?.trim();
if (!url || !/^postgres(ql)?:\/\//i.test(url)) {
  console.error("DATABASE_URL must be a postgresql:// connection string");
  process.exit(1);
}

const batch = Math.min(
  500,
  Math.max(1, parseInt(process.env.AIRDROP_QUEUE_BATCH_SIZE ?? "48", 10) || 48),
);
const maxRetries = Math.max(0, parseInt(process.env.AIRDROP_QUEUE_MAX_RETRIES ?? "5", 10) || 5);
const maxAttempts = maxRetries + 1;

const pool = new pg.Pool({ connectionString: url, max: 2 });

const sql = `SELECT jw.id AS id, jw.job_id AS "jobId"
     FROM job_wallets jw
     INNER JOIN jobs j ON j.id = jw.job_id
     WHERE jw.status = 'pending'
       AND (jw.next_attempt_at IS NULL OR jw.next_attempt_at <= NOW())
       AND jw.retry_count < $1
       AND j.status IN ('queued', 'running')
       AND NOT j.paused
     ORDER BY jw.job_id, jw.id
     LIMIT $2
     FOR UPDATE SKIP LOCKED`;

async function run() {
  const conn = await pool.connect();
  try {
    await conn.query("BEGIN");
    const t0 = process.hrtime.bigint();
    const { rows } = await conn.query(sql, [maxAttempts, batch]);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    await conn.query("ROLLBACK");
    console.log(
      JSON.stringify(
        {
          rowsLocked: rows.length,
          claimSelectMs: Math.round(ms * 1000) / 1000,
          batchLimit: batch,
        },
        null,
        2,
      ),
    );
  } finally {
    conn.release();
  }
  await pool.end();
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
