/**
 * Read-only queue / Postgres diagnostics for stuck normalized jobs.
 *
 *   npm run queue:diagnose
 *   node --env-file=.env scripts/diagnose-stuck-queue.mjs
 *
 * Schema note: this app uses `assigned_worker`, `updated_at`, `retry_count`, `error_message`
 * (not claimed_by / claimed_at / attempt_count / error). `queue_worker_heartbeats.last_heartbeat`
 * (not last_heartbeat_at).
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const require = createRequire(import.meta.url);
require(join(root, "database-url.js")).ensureDatabaseUrl();

const url = process.env.DATABASE_URL?.trim();
if (!url || !/^postgres(ql)?:\/\//i.test(url)) {
  console.error("DATABASE_URL must be a postgresql:// connection string");
  process.exit(1);
}

function envInt(name, fallback, min, max) {
  const n = parseInt(process.env[name]?.trim() ?? "", 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function queueStaleProcessingMs() {
  return envInt("AIRDROP_QUEUE_STALE_PROCESSING_MS", 10 * 60_000, 30_000, 24 * 60 * 60_000);
}
function queueStaleProcessingThresholdMs() {
  return Math.min(queueStaleProcessingMs(), 5 * 60_000);
}
function queueMaxRetries() {
  return envInt("AIRDROP_QUEUE_MAX_RETRIES", 5, 0, 100);
}
function queueMaxAttempts() {
  return queueMaxRetries() + 1;
}

function section(title) {
  console.log(`\n=== ${title} ===\n`);
}

async function main() {
  const pool = new pg.Pool({ connectionString: url, max: 3 });
  try {
    section("1) Queue runtime settings (queue_runtime_settings id=1) + env flags");
    const rt = await pool.query(`SELECT * FROM queue_runtime_settings WHERE id = 1`);
    console.log(JSON.stringify(rt.rows, null, 2));
    console.log(
      JSON.stringify(
        {
          AIRDROP_QUEUE_GLOBAL_PAUSED: process.env.AIRDROP_QUEUE_GLOBAL_PAUSED ?? "(unset)",
          AIRDROP_EMBEDDED_QUEUE_WORKER: process.env.AIRDROP_EMBEDDED_QUEUE_WORKER ?? "(unset)",
          AIRDROP_QUEUE_V2: process.env.AIRDROP_QUEUE_V2 ?? "(unset)",
        },
        null,
        2,
      ),
    );

    section("2) Job summary (last 50 jobs by created_at)");
    const jobs = await pool.query(`
      SELECT
        j.id,
        j.status,
        j.paused,
        j.created_at,
        COUNT(jw.id) AS total_wallets,
        COUNT(*) FILTER (WHERE jw.status = 'pending') AS pending,
        COUNT(*) FILTER (WHERE jw.status = 'processing') AS processing,
        COUNT(*) FILTER (WHERE jw.status = 'completed') AS completed,
        COUNT(*) FILTER (WHERE jw.status = 'failed') AS failed,
        MIN(jw.created_at) AS first_wallet_at,
        MAX(jw.updated_at) AS last_wallet_update
      FROM jobs j
      LEFT JOIN job_wallets jw ON jw.job_id = j.id
      GROUP BY j.id, j.status, j.paused, j.created_at
      ORDER BY j.created_at DESC
      LIMIT 50
    `);
    console.log(JSON.stringify(jobs.rows, null, 2));

    section("3) Stale processing rows (processing, updated_at older than 5 minutes)");
    console.log("(uses updated_at as last wallet row touch — no separate claimed_at column)\n");
    const stale = await pool.query(`
      SELECT id, job_id, status, assigned_worker, updated_at, retry_count,
             LEFT(COALESCE(error_message, ''), 200) AS error_message_preview
      FROM job_wallets
      WHERE status = 'processing'
        AND updated_at < NOW() - INTERVAL '5 minutes'
      ORDER BY updated_at ASC
      LIMIT 100
    `);
    console.log(JSON.stringify(stale.rows, null, 2));

    section("4) Pending rows waiting on next_attempt_at backoff");
    const backoff = await pool.query(`
      SELECT id, job_id, status, next_attempt_at, retry_count,
             LEFT(COALESCE(error_message, ''), 120) AS error_message_preview
      FROM job_wallets
      WHERE status = 'pending'
        AND next_attempt_at IS NOT NULL
        AND next_attempt_at > NOW()
      ORDER BY next_attempt_at ASC
      LIMIT 100
    `);
    console.log(JSON.stringify(backoff.rows, null, 2));

    section("5) Claimable pending (simple count — no signer / NOT EXISTS filters)");
    const claimable = await pool.query(`
      SELECT COUNT(*)::text AS claimable_pending
      FROM job_wallets
      WHERE status = 'pending'
        AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())
    `);
    console.log(JSON.stringify(claimable.rows, null, 2));

    section("6) Worker heartbeats");
    const hb = await pool.query(`
      SELECT *
      FROM queue_worker_heartbeats
      ORDER BY last_heartbeat DESC NULLS LAST
      LIMIT 100
    `);
    console.log(JSON.stringify(hb.rows, null, 2));

    section("7) pg_stat_activity (this database)");
    const act = await pool.query(`
      SELECT pid, state, wait_event_type, wait_event, query_start, LEFT(query, 300) AS query
      FROM pg_stat_activity
      WHERE datname = current_database()
      ORDER BY query_start DESC NULLS LAST
      LIMIT 50
    `);
    console.log(JSON.stringify(act.rows, null, 2));

    section("8) Runtime env snapshot (effective values)");
    console.log(
      JSON.stringify(
        {
          AIRDROP_QUEUE_BATCH_SIZE: process.env.AIRDROP_QUEUE_BATCH_SIZE ?? "(unset → default 48)",
          AIRDROP_MAX_PARALLEL_TXS: process.env.AIRDROP_MAX_PARALLEL_TXS ?? "(unset)",
          AIRDROP_QUEUE_WORKER_POLL_MS: process.env.AIRDROP_QUEUE_WORKER_POLL_MS ?? "(unset → default 500)",
          AIRDROP_DB_CONNECTION_LIMIT: process.env.AIRDROP_DB_CONNECTION_LIMIT ?? "(unset)",
          AIRDROP_QUEUE_GLOBAL_PAUSED: process.env.AIRDROP_QUEUE_GLOBAL_PAUSED ?? "(unset)",
          AIRDROP_EMBEDDED_QUEUE_WORKER: process.env.AIRDROP_EMBEDDED_QUEUE_WORKER ?? "(unset)",
          AIRDROP_WORKER_ID: process.env.AIRDROP_WORKER_ID ?? "(unset)",
          NODE_APP_INSTANCE: process.env.NODE_APP_INSTANCE ?? "(unset)",
          AIRDROP_QUEUE_STALE_PROCESSING_MS: String(queueStaleProcessingMs()),
          stale_processing_threshold_ms_effective: queueStaleProcessingThresholdMs(),
          queue_max_attempts: queueMaxAttempts(),
        },
        null,
        2,
      ),
    );
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
