/**
 * Quick sanity check for pending COUNT(*) cost (run against staging with realistic row counts).
 *
 *   node --env-file=.env scripts/benchmark-pending-count.mjs
 *
 * Uses DATABASE_URL; prints duration — not a full load test.
 */
import pg from "pg";

const url = process.env.DATABASE_URL?.trim();
if (!url || !/^postgres(ql)?:\/\//i.test(url)) {
  console.error("DATABASE_URL must be a postgresql:// connection string");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: url, max: 2 });

const sql = `SELECT COUNT(*)::text AS c FROM job_wallets WHERE status = 'pending'
  AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())`;

async function run() {
  const t0 = Date.now();
  const { rows } = await pool.query(sql);
  const ms = Date.now() - t0;
  console.log(JSON.stringify({ pendingApprox: rows[0]?.c, ms }, null, 2));
  await pool.end();
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
