/**
 * Per-process queue worker liveness / starvation signals (embedded + standalone worker).
 * Scraped via `/api/internal/metrics` from this Node process only.
 */

let refreshSeqObserved = 0;
let lastClaimSuccessAtMs = 0;
let lastWalletCompletionAtMs = 0;
let consecutiveEmptyPolls = 0;
let totalClaimsWithRows = 0;
let totalEmptyPolls = 0;
let claimLatencySumMs = 0;
let claimLatencySamples = 0;
let lastClaimLatencyMs = 0;
let lastAlertStarvationMs = 0;

/** Last refreshSequence from queue-runtime-settings observed in this process (via hook). */
export function observeRuntimeRefreshSequence(seq: number): void {
  refreshSeqObserved = seq;
}

export function recordPollMetrics(opts: {
  claimedRows: number;
  claimLatencyMs: number;
  runtimeRefreshSequence: number;
}): void {
  refreshSeqObserved = opts.runtimeRefreshSequence;
  lastClaimLatencyMs = opts.claimLatencyMs;
  claimLatencySamples++;
  claimLatencySumMs += opts.claimLatencyMs;

  if (opts.claimedRows > 0) {
    consecutiveEmptyPolls = 0;
    totalClaimsWithRows++;
    lastClaimSuccessAtMs = Date.now();
    return;
  }
  consecutiveEmptyPolls++;
  totalEmptyPolls++;
}

export function markWalletCompleted(): void {
  lastWalletCompletionAtMs = Date.now();
}

export type QueueWorkerLivenessSnapshot = {
  pid: number;
  refreshSeqObserved: number;
  lastClaimSuccessAtMs: number;
  lastWalletCompletionAtMs: number;
  consecutiveEmptyPolls: number;
  totalClaimsWithRows: number;
  totalEmptyPolls: number;
  emptyPollRate: number;
  avgClaimLatencyMs: number;
  lastClaimLatencyMs: number;
  queueIdleMs: number;
};

export function getQueueWorkerLivenessSnapshot(): QueueWorkerLivenessSnapshot {
  const now = Date.now();
  const g = globalThis as unknown as { __makaluWorkerStartMs?: number };
  const startMs = g.__makaluWorkerStartMs ?? now;
  const idleMs = lastClaimSuccessAtMs > 0 ? now - lastClaimSuccessAtMs : now - startMs;
  const totalPolls = totalClaimsWithRows + totalEmptyPolls;
  return {
    pid: typeof process.pid === "number" ? process.pid : 0,
    refreshSeqObserved,
    lastClaimSuccessAtMs,
    lastWalletCompletionAtMs,
    consecutiveEmptyPolls,
    totalClaimsWithRows,
    totalEmptyPolls,
    emptyPollRate: totalPolls > 0 ? totalEmptyPolls / totalPolls : 0,
    avgClaimLatencyMs: claimLatencySamples > 0 ? claimLatencySumMs / claimLatencySamples : 0,
    lastClaimLatencyMs,
    queueIdleMs: idleMs,
  };
}

/** Starvation: SQL says rows are claimable but this worker repeatedly gets empty batches (multi-worker contention). */
export function maybeAlertClaimStarvation(matchClaimSqlCount: number): void {
  if (matchClaimSqlCount <= 0) return;
  if (consecutiveEmptyPolls < 80) return;
  const now = Date.now();
  if (now - lastAlertStarvationMs < 120_000) return;
  lastAlertStarvationMs = now;
  console.warn(
    `[queue-worker] CLAIM_STARVATION alert: ${consecutiveEmptyPolls} consecutive empty polls while ~${matchClaimSqlCount} wallet row(s) match claim filters (other workers / SKIP_LOCKED contention, or tuning).`,
  );
}

export function initWorkerLivenessClock(): void {
  const g = globalThis as unknown as { __makaluWorkerStartMs?: number };
  if (g.__makaluWorkerStartMs == null) g.__makaluWorkerStartMs = Date.now();
}

export function getConsecutiveEmptyPolls(): number {
  return consecutiveEmptyPolls;
}
