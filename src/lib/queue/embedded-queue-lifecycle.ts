import { embeddedNormalizedQueueWorkerEnabled } from "./config";
import { getQueueRuntimeFlagsSync } from "./queue-runtime-settings";
import { runAirdropQueueWorker } from "./queue-worker";

let loops: AbortController[] = [];

/** Distinct worker id per embedded loop (same process — avoids heartbeat collisions). */
function embeddedWorkerInstanceId(index: number): string {
  const envBase = process.env.AIRDROP_WORKER_ID?.trim();
  const suffix = `-e${index}`;
  const maxLen = 64;
  if (envBase) {
    const room = maxLen - suffix.length;
    const base = envBase.slice(0, Math.max(1, room));
    return `${base}${suffix}`.slice(0, maxLen);
  }
  const pid = typeof process.pid === "number" ? String(process.pid) : "0";
  return `w-${pid}${suffix}`.slice(0, maxLen);
}

/** Start N concurrent queue loops in this process when embedded worker is enabled (N from DB, 1–10). */
export function startEmbeddedQueueWorkerIfEligible(): void {
  if (!embeddedNormalizedQueueWorkerEnabled()) {
    stopEmbeddedQueueWorker();
    return;
  }
  const raw = getQueueRuntimeFlagsSync().embeddedWorkerCount ?? 1;
  const n = Math.min(10, Math.max(1, Math.floor(Number.isFinite(raw) ? raw : 1)));
  stopEmbeddedQueueWorker();
  for (let i = 0; i < n; i++) {
    const abort = new AbortController();
    loops.push(abort);
    const workerId = embeddedWorkerInstanceId(i);
    void runAirdropQueueWorker(abort.signal, { workerId }).finally(() => {
      loops = loops.filter((c) => c !== abort);
    });
  }
}

export function stopEmbeddedQueueWorker(): void {
  for (const a of loops) {
    a.abort();
  }
  loops = [];
}

export function embeddedQueueWorkerLoopRunning(): boolean {
  return loops.length > 0;
}

/** How many embedded loops are currently armed (after last start). */
export function embeddedQueueWorkerActiveLoopCount(): number {
  return loops.length;
}
