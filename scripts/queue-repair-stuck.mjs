/**
 * Manual repair: stale `processing` → `pending`, then parent job status reconciliation.
 *
 *   npm run queue:repair-stuck              # dry-run (counts + preview)
 *   npm run queue:repair-stuck -- --apply   # execute updates
 *
 * Keep SQL aligned with `reconcileStaleProcessingRows` + `reconcileAllJobStatusesFromWallets`
 * in `src/lib/queue/job-queue-repo.ts`.
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const require = createRequire(import.meta.url);
require(join(root, "database-url.js")).ensureDatabaseUrl();

const apply = process.argv.includes("--apply");

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

const STALE_UPDATE_SQL = `
UPDATE job_wallets
SET status = 'pending',
    assigned_worker = NULL,
    next_attempt_at = NULL,
    error_message = LEFT(
      COALESCE(error_message, '') || ' | stale processing reset (was worker ' || COALESCE(assigned_worker, '?') || ')',
      8000
    ),
    updated_at = NOW()
WHERE status = 'processing'
  AND updated_at < $1
  AND retry_count < $2`;

const JOB_STATUS_RECONCILE_SQL = `
WITH computed AS (
  SELECT j.id,
    CASE
      WHEN j.paused IS TRUE THEN j.status
      WHEN j.status IN ('draft', 'cancelled') THEN j.status
      WHEN EXISTS (
        SELECT 1 FROM job_wallets jw
        WHERE jw.job_id = j.id AND jw.status IN ('pending', 'processing')
      ) THEN CASE WHEN j.status = 'draft' THEN j.status ELSE 'running' END
      WHEN EXISTS (
        SELECT 1 FROM job_wallets jw
        WHERE jw.job_id = j.id AND jw.status = 'failed'
      ) THEN 'failed'
      ELSE 'completed'
    END AS new_status
  FROM jobs j
  WHERE EXISTS (SELECT 1 FROM job_wallets jw WHERE jw.job_id = j.id)
)
UPDATE jobs j
SET status = c.new_status,
    updated_at = NOW()
FROM computed c
WHERE j.id = c.id AND j.status IS DISTINCT FROM c.new_status`;

async function main() {
  const pool = new pg.Pool({ connectionString: url, max: 2 });
  const before = new Date(Date.now() - queueStaleProcessingThresholdMs());
  const maxAttempts = queueMaxAttempts();

  try {
    const cntStale = await pool.query(
      `SELECT COUNT(*)::text AS c FROM job_wallets WHERE status = 'processing' AND updated_at < $1 AND retry_count < $2`,
      [before, maxAttempts],
    );
    const preview = await pool.query(
      `SELECT id, job_id, assigned_worker, updated_at FROM job_wallets
       WHERE status = 'processing' AND updated_at < $1 AND retry_count < $2
       ORDER BY updated_at ASC LIMIT 25`,
      [before, maxAttempts],
    );

    const cntJobsWouldChange = await pool.query(
      `WITH computed AS (
         SELECT j.id,
           CASE
             WHEN j.paused IS TRUE THEN j.status
             WHEN j.status IN ('draft', 'cancelled') THEN j.status
             WHEN EXISTS (
               SELECT 1 FROM job_wallets jw
               WHERE jw.job_id = j.id AND jw.status IN ('pending', 'processing')
             ) THEN CASE WHEN j.status = 'draft' THEN j.status ELSE 'running' END
             WHEN EXISTS (
               SELECT 1 FROM job_wallets jw
               WHERE jw.job_id = j.id AND jw.status = 'failed'
             ) THEN 'failed'
             ELSE 'completed'
           END AS new_status
         FROM jobs j
         WHERE EXISTS (SELECT 1 FROM job_wallets jw WHERE jw.job_id = j.id)
       )
       SELECT COUNT(*)::text AS c FROM jobs j
       INNER JOIN computed c ON c.id = j.id AND j.status IS DISTINCT FROM c.new_status`,
    );

    console.log(
      JSON.stringify(
        {
          mode: apply ? "apply" : "dry-run",
          staleThresholdMs: queueStaleProcessingThresholdMs(),
          staleCutoffIso: before.toISOString(),
          before: {
            stale_processing_rows_matching: Number(cntStale.rows[0]?.c ?? 0),
            parent_jobs_status_rows_to_update: Number(cntJobsWouldChange.rows[0]?.c ?? 0),
          },
          previewStaleWalletIds: preview.rows,
        },
        null,
        2,
      ),
    );

    if (!apply) {
      console.log("\nDry-run only. Re-run with: node scripts/queue-repair-stuck.mjs --apply\n");
      return;
    }

    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      const u1 = await c.query(STALE_UPDATE_SQL, [before, maxAttempts]);
      const u2 = await c.query(JOB_STATUS_RECONCILE_SQL);
      await c.query("COMMIT");
      console.log(
        JSON.stringify(
          {
            after: {
              stale_processing_reset_rows: u1.rowCount ?? 0,
              parent_jobs_status_updated_rows: u2.rowCount ?? 0,
            },
          },
          null,
          2,
        ),
      );
    } catch (e) {
      await c.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      c.release();
    }
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
