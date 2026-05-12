/**
 * Measures SELECT … FOR UPDATE SKIP LOCKED (claim-shaped query) inside a transaction that rolls back,
 * so rows are not left in `processing`. Requires MySQL 8+ / MariaDB with SKIP LOCKED.
 *
 *   node --env-file=.env scripts/bench-queue-claim.mjs
 *
 * Env: DATABASE_URL, optional AIRDROP_QUEUE_BATCH_SIZE (default 20), AIRDROP_QUEUE_MAX_RETRIES (default 5).
 */
import mysql from "mysql2/promise";

const url = process.env.DATABASE_URL?.trim();
if (!url) {
  console.error("DATABASE_URL required");
  process.exit(1);
}

const batch = Math.min(
  500,
  Math.max(1, parseInt(process.env.AIRDROP_QUEUE_BATCH_SIZE ?? "20", 10) || 20),
);
const maxRetries = Math.max(0, parseInt(process.env.AIRDROP_QUEUE_MAX_RETRIES ?? "5", 10) || 5);
const maxAttempts = maxRetries + 1;

const pool = mysql.createPool({ uri: url, connectionLimit: 2 });

const sql = `SELECT jw.id AS id, jw.job_id AS jobId
     FROM job_wallets jw
     INNER JOIN jobs j ON j.id = jw.job_id
     WHERE jw.status = 'pending'
       AND (jw.next_attempt_at IS NULL OR jw.next_attempt_at <= CURRENT_TIMESTAMP(3))
       AND jw.retry_count < ?
       AND j.status IN ('queued', 'running')
       AND j.paused = 0
     ORDER BY jw.job_id, jw.id
     LIMIT ?
     FOR UPDATE SKIP LOCKED`;

async function run() {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const t0 = process.hrtime.bigint();
    const [rows] = await conn.query(sql, [maxAttempts, batch]);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    await conn.rollback();
    console.log(
      JSON.stringify(
        {
          rowsLocked: Array.isArray(rows) ? rows.length : 0,
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
