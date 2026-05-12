/**
 * Operational CLI for the normalized queue (PostgreSQL).
 *
 * Usage (from repo root):
 *   npm run queue:admin -- stale
 *   npm run queue:admin -- reconcile-job <jobId>
 *   npm run queue:admin -- diagnose-queue
 *   npm run queue:admin -- dump-worker-state
 *   npm run queue:admin -- reconcile-runtime-flags
 *   npm run queue:admin -- recover-stalled-queue
 *   npm run queue:admin -- pause-job <jobId>
 *   npm run queue:admin -- resume-job <jobId>
 *   npm run queue:admin -- retry-failed --all
 *   npm run queue:admin -- retry-failed <jobId>
 *   npm run queue:admin -- requeue-incomplete <jobId>
 *   npm run queue:admin -- workers
 *   npm run queue:admin -- diagnose
 *   npm run queue:admin -- promote-draft <jobId>
 *
 * Global pause (no claims): set AIRDROP_QUEUE_GLOBAL_PAUSED=true on workers.
 *
 * Requires DATABASE_URL (or DB_* vars merged by database-url.js).
 */
import { getPostgresPool, pgQuery } from "../src/lib/postgres";
import { getQueueOperationalSnapshot } from "../src/lib/queue/queue-operations-snapshot";
import {
  getQueueRuntimeCacheMeta,
  getQueueRuntimeFlagsSync,
  refreshQueueRuntimeCache,
} from "../src/lib/queue/queue-runtime-settings";
import {
  adminPromoteDraftToQueued,
  adminRecoverStalledQueue,
  adminRequeueIncompleteJob,
  adminRetryFailedWallets,
  adminSetJobPaused,
  getQueueClaimDiagnostics,
  refreshJobAggregates,
  reconcileStaleProcessingRows,
} from "../src/lib/queue/job-queue-repo";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (cmd === "stale") {
    const n = await reconcileStaleProcessingRows();
    console.log(`[queue-admin] reset ${n} stale processing row(s) to pending`);
    process.exit(0);
  }

  if (cmd === "reconcile-job" && args[1]?.trim()) {
    await refreshJobAggregates(args[1].trim());
    console.log(`[queue-admin] full recount + status for job ${args[1].trim()}`);
    process.exit(0);
  }

  if (cmd === "pause-job" && args[1]?.trim()) {
    await adminSetJobPaused(args[1].trim(), true);
    console.log(`[queue-admin] paused job ${args[1].trim()}`);
    process.exit(0);
  }

  if (cmd === "resume-job" && args[1]?.trim()) {
    await adminSetJobPaused(args[1].trim(), false);
    console.log(`[queue-admin] resumed job ${args[1].trim()}`);
    process.exit(0);
  }

  if (cmd === "retry-failed") {
    let jobId: string | undefined;
    let all = false;
    for (let i = 1; i < args.length; i++) {
      const a = args[i];
      if (a === "--all") all = true;
      else if (a === "--job" && args[i + 1]) {
        jobId = args[++i];
      } else if (a && !a.startsWith("-")) {
        jobId = a;
      }
    }
    if (all && jobId) {
      console.error("[queue-admin] use either --all or a single job id, not both");
      process.exit(1);
    }
    if (!all && !jobId) {
      console.error("[queue-admin] retry-failed requires <jobId> or --all");
      process.exit(1);
    }
    const n = await adminRetryFailedWallets(all ? undefined : jobId!);
    console.log(`[queue-admin] re-queued ${n} failed wallet row(s)`);
    process.exit(0);
  }

  if (cmd === "requeue-incomplete" && args[1]?.trim()) {
    const n = await adminRequeueIncompleteJob(args[1].trim());
    console.log(`[queue-admin] re-queued ${n} non-completed wallet row(s) for job ${args[1].trim()}`);
    process.exit(0);
  }

  if (cmd === "workers") {
    const pool = await getPostgresPool();
    const rows = await pgQuery<Record<string, unknown>>(
      pool,
      `SELECT worker_id, hostname, active_job_id, last_heartbeat, iterations, rows_ok, rows_fail, last_batch_size
       FROM queue_worker_heartbeats
       ORDER BY last_heartbeat DESC
       LIMIT 50`,
    );
    console.table(rows);
    process.exit(0);
  }

  if (cmd === "diagnose-queue") {
    const d = await getQueueClaimDiagnostics();
    const snap = await getQueueOperationalSnapshot();
    console.log(
      JSON.stringify(
        {
          diagnostics: d,
          stalledQueuedJobsSample: snap.stalledQueuedJobsSample,
          staleHeartbeatWorkers: snap.staleHeartbeatWorkers,
          draftJobsWithPendingWallets: snap.draftJobsWithPendingWallets,
          runtimeMeta: snap.runtimeMeta,
        },
        null,
        2,
      ),
    );
    process.exit(0);
  }

  if (cmd === "dump-worker-state") {
    const pool = await getPostgresPool();
    const settings = await pgQuery<Record<string, unknown>>(pool, `SELECT * FROM queue_runtime_settings WHERE id = 1`);
    const heartbeats = await pgQuery<Record<string, unknown>>(
      pool,
      `SELECT worker_id, hostname, active_job_id, last_heartbeat, iterations, rows_ok, rows_fail, last_batch_size, updated_at
       FROM queue_worker_heartbeats
       ORDER BY last_heartbeat DESC
       LIMIT 80`,
    );
    console.log(JSON.stringify({ queue_runtime_settings: settings[0] ?? null, queue_worker_heartbeats: heartbeats }, null, 2));
    process.exit(0);
  }

  if (cmd === "reconcile-runtime-flags") {
    await refreshQueueRuntimeCache();
    console.log(
      JSON.stringify(
        {
          meta: getQueueRuntimeCacheMeta(),
          flags: getQueueRuntimeFlagsSync(),
        },
        null,
        2,
      ),
    );
    process.exit(0);
  }

  if (cmd === "recover-stalled-queue") {
    let noDraft = false;
    for (let i = 1; i < args.length; i++) {
      if (args[i] === "--no-draft-promote") noDraft = true;
    }
    const r = await adminRecoverStalledQueue({ promoteDrafts: !noDraft });
    console.log(
      `[queue-admin] stale processing reset: ${r.staleProcessingReset}; draft jobs promoted: ${r.draftJobsPromoted}`,
    );
    process.exit(0);
  }

  if (cmd === "diagnose") {
    const d = await getQueueClaimDiagnostics();
    console.log(JSON.stringify(d, null, 2));
    console.log("");
    if (d.globalPaused) {
      console.log("→ Unset AIRDROP_QUEUE_GLOBAL_PAUSED (workers will not claim anything while true).");
    }
    if (d.pendingButDraftJob > 0) {
      console.log(
        `→ ${d.pendingButDraftJob} pending wallet(s) are under jobs still in 'draft'. Run Start in the UI, or: npm run queue:admin -- promote-draft <jobId>`,
      );
    }
    if (d.matchingClaimSql === 0 && d.pendingBlockedByJobState > 0) {
      console.log(
        "→ Some pending rows are blocked by job status or paused=1. Use resume-job, or ensure status is queued/running.",
      );
    }
    if (d.pendingBackoffFuture > 0) {
      console.log(
        `→ ${d.pendingBackoffFuture} pending row(s) wait for next_attempt_at (retry backoff). They will become claimable when that time passes.`,
      );
    }
    if (d.pendingRetryCap > 0) {
      console.log(
        `→ ${d.pendingRetryCap} pending row(s) have retry_count >= max attempts (mis-synced?). Run reconcile-job <id> or inspect DB.`,
      );
    }
    process.exit(0);
  }

  if (cmd === "promote-draft" && args[1]?.trim()) {
    const ok = await adminPromoteDraftToQueued(args[1].trim());
    if (!ok) {
      console.error(`[queue-admin] job ${args[1].trim()} is not in 'draft' or not found`);
      process.exit(1);
    }
    console.log(`[queue-admin] promoted ${args[1].trim()} from draft → queued`);
    process.exit(0);
  }

  console.error(`Usage:
  queue-admin stale                      — reset stuck processing rows (see AIRDROP_QUEUE_STALE_PROCESSING_MS)
  queue-admin reconcile-job <id>       — recompute job counters + status from job_wallets
  queue-admin diagnose-queue            — diagnostics + stalled-queue snapshot + runtime meta (JSON)
  queue-admin dump-worker-state        — queue_runtime_settings row + heartbeats (JSON)
  queue-admin reconcile-runtime-flags  — reload runtime flags from DB and print (JSON)
  queue-admin recover-stalled-queue    — reconcile stale processing + promote orphan drafts with pending rows
  queue-admin recover-stalled-queue --no-draft-promote — stale reset only
  queue-admin pause-job <id>           — set jobs.paused=1
  queue-admin resume-job <id>          — set jobs.paused=0
  queue-admin retry-failed <jobId>     — failed → pending for one job
  queue-admin retry-failed --all       — failed → pending for every job
  queue-admin requeue-incomplete <id>  — all non-completed wallets → pending for one job
  queue-admin workers                  — recent worker heartbeats
  queue-admin diagnose                 — why the worker may claim 0 rows (draft/paused/backoff)
  queue-admin promote-draft <id>       — draft → queued when Start was never applied`);
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
