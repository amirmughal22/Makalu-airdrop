import { claimQueuedDueJob, listQueuedDueJobIds, listStaleRunningJobs, saveJob } from "./job-service";
import { activeJobRunCount, isJobRunActive } from "./job-runners";
import { maxConcurrentAirdropJobs } from "./rpc-retry";
import { runAirdropJob } from "./run-job";

/** Queue polling interval (standalone worker). Default 5000 ms; min 500; max 60000. */
export function queuePollIntervalMs(): number {
  const raw = process.env.AIRDROP_QUEUE_POLL_MS?.trim() ?? "";
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return 5000;
  return Math.min(60_000, Math.max(500, n));
}

/** Running jobs older than this are assumed abandoned after a process crash. Default 30 minutes. */
export function staleRunningMs(): number {
  const raw = process.env.AIRDROP_STALE_RUNNING_MS?.trim() ?? "";
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return 30 * 60_000;
  return Math.min(24 * 60 * 60_000, Math.max(60_000, n));
}

/** How often stale-running reconciliation runs (standalone worker + embedded worker). Default 60s; min 5s; max 1h. */
export function staleReconcileIntervalMs(): number {
  const raw = process.env.AIRDROP_STALE_RECONCILE_MS?.trim() ?? "";
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return 60_000;
  return Math.min(60 * 60_000, Math.max(5_000, n));
}

const g = globalThis as unknown as {
  __makaluQueueStarted?: boolean;
  __makaluQueueTicking?: boolean;
  /** Another tick was requested while a tick was in flight — run again without waiting for the poll interval. */
  __makaluQueueTickPending?: boolean;
  __makaluLastStaleReconcileMs?: number;
  /** One-shot hint: normalized `jobs`/`job_wallets` need `worker:queue`, not the embedded legacy poll. */
  __makaluWarnedNormalizedWorkerNeedV2?: boolean;
};

async function reconcileStaleRunningJobs() {
  const interval = staleReconcileIntervalMs();
  const now = Date.now();
  const last = g.__makaluLastStaleReconcileMs;
  if (last != null && now - last < interval) return;
  g.__makaluLastStaleReconcileMs = now;
  try {
    const nowIso = new Date().toISOString();
    const staleBeforeIso = new Date(Date.now() - staleRunningMs()).toISOString();
    const stale = await listStaleRunningJobs(2000, staleBeforeIso);
    for (const job of stale) {
      if (isJobRunActive(job.jobId)) continue;
      for (const r of job.results) {
        if (r.status === "pending" || r.status === "submitted") {
          r.status = "queued";
          r.error = undefined;
          r.txHash = undefined;
          r.signerAddress = undefined;
          r.rpcUrl = undefined;
        }
      }
      job.status = "queued";
      job.paused = false;
      job.queuedAt = nowIso;
      await saveJob(job);
    }
  } catch (e) {
    console.error("[job-queue] stale-running reconciliation failed", e);
  }
}

async function runQueueTickCycle(): Promise<void> {
  await reconcileStaleRunningJobs();

  const { useNormalizedJobStorage } = await import("./normalized-job-config");
  const { isAirdropQueueV2Enabled } = await import("./queue/config");
  if (useNormalizedJobStorage() && !isAirdropQueueV2Enabled() && !g.__makaluWarnedNormalizedWorkerNeedV2) {
    g.__makaluWarnedNormalizedWorkerNeedV2 = true;
    console.warn(
      "[job-queue] Normalized jobs (`jobs` / `job_wallets`) are not driven by this embedded queue (it only polls legacy `airdrop_jobs`). " +
        "Set AIRDROP_QUEUE_V2=true and run `npm run worker:queue` beside the app with the same DATABASE_URL.",
    );
  }

  const nowIso = new Date().toISOString();
  const jobCap = maxConcurrentAirdropJobs();
  const available = jobCap - activeJobRunCount();
  if (available <= 0) return;

  const queuedIds = await listQueuedDueJobIds(Math.min(1000, Math.max(available * 4, available)), nowIso);
  if (!queuedIds.length) return;

  for (const jobId of queuedIds) {
    if (activeJobRunCount() >= jobCap) break;
    if (isJobRunActive(jobId)) continue;
    const claimed = await claimQueuedDueJob(jobId, nowIso);
    if (!claimed) continue;
    runAirdropJob(claimed.jobId);
  }
}

async function tickQueue() {
  if (g.__makaluQueueTicking) {
    g.__makaluQueueTickPending = true;
    return;
  }
  g.__makaluQueueTicking = true;
  try {
    while (true) {
      await runQueueTickCycle();
      if (!g.__makaluQueueTickPending) break;
      g.__makaluQueueTickPending = false;
    }
  } catch (e) {
    console.error("[job-queue] tick failed", e);
  } finally {
    g.__makaluQueueTicking = false;
    if (g.__makaluQueueTickPending) void tickQueue();
  }
}

export function ensureJobQueueWorker(): void {
  if (g.__makaluQueueStarted) return;
  g.__makaluQueueStarted = true;
  const pollMs = queuePollIntervalMs();
  /** Defer so HTTP handlers / first paint are not competing with cold DB + job imports on the same tick. */
  const kick = () => {
    void tickQueue();
    setInterval(() => {
      void tickQueue();
    }, pollMs);
  };
  if (typeof setImmediate === "function") setImmediate(kick);
  else setTimeout(kick, 0);
}

export async function triggerQueueTick(): Promise<void> {
  await tickQueue();
}
