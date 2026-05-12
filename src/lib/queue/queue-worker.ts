import { MAKALU_CHAIN_ID_DECIMAL } from "../chain";
import { executeEvmTransfer, readErc20Decimals } from "../evm-send-transfer";
import { humanizeAirdropError } from "../humanize-airdrop-error";
import { interChunkDelayMs, maxParallelTxsPerWave, sleep } from "../rpc-retry";
import {
  claimWalletBatch,
  recordWalletFailure,
  recordWalletSuccess,
  reconcileStaleProcessingRows,
} from "./job-queue-repo";
import {
  queueAdaptiveParallelEnabled,
  queueWorkerId,
  queueWorkerInterBatchSleepMs,
  queueWorkerPollMs,
} from "./config";
import { upsertWorkerHeartbeat } from "./worker-heartbeat";
import {
  getConsecutiveEmptyPolls,
  initWorkerLivenessClock,
  maybeAlertClaimStarvation,
  recordPollMetrics,
} from "./queue-worker-liveness";
import { collectQueueClaimBlockers } from "./config";
import { getQueueClaimDiagnostics } from "./job-queue-repo";
import { getQueueRuntimeCacheMeta, refreshQueueRuntimeCache } from "./queue-runtime-settings";
import type { ClaimedWalletRow } from "./types";
import type { WorkerFileLogger } from "./worker-file-logger";

const decimalsCache = new Map<string, number>();

function decimalsCacheKey(row: ClaimedWalletRow): string {
  const cid = row.chainId ?? MAKALU_CHAIN_ID_DECIMAL;
  const tok = (row.tokenAddress ?? "").toLowerCase();
  return `${cid}:${tok}`;
}

async function erc20DecimalsCached(row: ClaimedWalletRow): Promise<number> {
  if (row.mode !== "erc20" || !row.tokenAddress) return 18;
  const key = decimalsCacheKey(row);
  const hit = decimalsCache.get(key);
  if (hit != null) return hit;
  const d = await readErc20Decimals(
    row.tokenAddress as `0x${string}`,
    row.chainId ?? MAKALU_CHAIN_ID_DECIMAL,
  );
  decimalsCache.set(key, d);
  return d;
}

/** @returns true when the row reached `completed` (on-chain success recorded). */
export async function processClaimedWalletRow(row: ClaimedWalletRow): Promise<boolean> {
  if (!row.signerAddress) {
    await recordWalletFailure(row.id, row.jobId, "Missing signer_address on wallet row", row.retryCount);
    return false;
  }
  try {
    const tokenDecimals = await erc20DecimalsCached(row);
    const { txHash, rpcUrl } = await executeEvmTransfer({
      mode: row.mode,
      tokenAddress: row.tokenAddress,
      chainId: row.chainId,
      owner: row.owner,
      signerAddress: row.signerAddress,
      recipient: row.walletAddress as `0x${string}`,
      amount: row.amount,
      tokenDecimals: row.mode === "erc20" ? tokenDecimals : undefined,
    });
    await recordWalletSuccess(row.id, row.jobId, txHash, rpcUrl);
    return true;
  } catch (e) {
    await recordWalletFailure(row.id, row.jobId, humanizeAirdropError(e), row.retryCount);
    return false;
  }
}

export type RunAirdropQueueWorkerOptions = {
  workerId?: string;
  /** Optional JSONL file logger (standalone worker). */
  fileLogger?: WorkerFileLogger;
  /** After loop ends (abort or normal) — e.g. delete heartbeat. */
  onStopped?: () => Promise<void>;
};

/** Main loop for normalized queue workers (`npm run worker:queue` or embedded). */
export async function runAirdropQueueWorker(
  signal?: AbortSignal,
  options?: RunAirdropQueueWorkerOptions,
): Promise<void> {
  const workerId = options?.workerId?.trim() || queueWorkerId();
  const fileLog = options?.fileLogger;
  let iteration = 0;
  const interSleep = queueWorkerInterBatchSleepMs();
  let cumulativeOk = 0;
  let cumulativeFail = 0;
  let lastBatchFailRatio = 0;
  let lastIdleDiagMs = 0;
  const idleDiag =
    process.env.AIRDROP_QUEUE_WORKER_DEBUG?.trim() === "1" ||
    process.env.AIRDROP_QUEUE_WORKER_DEBUG?.trim()?.toLowerCase() === "true";

  initWorkerLivenessClock();
  fileLog?.log("info", "queue_worker_start", { workerId });
  const runtimeCheckEvery = 15;
  const idleExitPolls = parseInt(process.env.AIRDROP_QUEUE_WORKER_IDLE_EXIT_AFTER_POLLS?.trim() ?? "", 10);
  const heapDiagMs = parseInt(process.env.AIRDROP_QUEUE_HEAP_DIAG_MS?.trim() ?? "", 10);
  if (Number.isFinite(heapDiagMs) && heapDiagMs >= 30_000) {
    setInterval(() => {
      const m = process.memoryUsage();
      console.info(
        `[queue-worker] heap rss=${Math.round(m.rss / 1024 / 1024)}MB heapUsed=${Math.round(m.heapUsed / 1024 / 1024)}MB`,
      );
    }, heapDiagMs).unref?.();
  }

  while (!signal?.aborted) {
    iteration++;
    if (iteration === 1 || iteration % 40 === 0) {
      try {
        const n = await reconcileStaleProcessingRows();
        if (n > 0) console.log(`[queue-worker] reconciled ${n} stale processing row(s)`);
      } catch (e) {
        console.error("[queue-worker] stale reconciliation failed", e);
      }
    }

    let batch: ClaimedWalletRow[] = [];
    const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
    try {
      batch = await claimWalletBatch(workerId);
    } catch (e) {
      console.error("[queue-worker] claim failed", e);
      await sleep(queueWorkerPollMs());
      continue;
    }
    const t1 = typeof performance !== "undefined" ? performance.now() : Date.now();
    const claimLatencyMs = Math.max(0, t1 - t0);
    const meta = getQueueRuntimeCacheMeta();
    recordPollMetrics({
      claimedRows: batch.length,
      claimLatencyMs,
      runtimeRefreshSequence: meta.refreshSequence,
    });

    if (!batch.length) {
      if (iteration % runtimeCheckEvery === 0) {
        await refreshQueueRuntimeCache();
        const blockers = collectQueueClaimBlockers();
        if (blockers.length > 0) {
          const msg = blockers.join(" | ");
          console.error("[queue-worker] Runtime queue block — exiting:", msg);
          fileLog?.log("error", "runtime_queue_blocked", { blockers });
          process.exit(1);
        }
      }

      if (Number.isFinite(idleExitPolls) && idleExitPolls > 0 && getConsecutiveEmptyPolls() >= idleExitPolls) {
        console.warn(
          `[queue-worker] Exiting after ${idleExitPolls} empty polls (AIRDROP_QUEUE_WORKER_IDLE_EXIT_AFTER_POLLS).`,
        );
        fileLog?.log("warn", "idle_exit_threshold", { polls: idleExitPolls });
        process.exit(0);
      }

      if (idleDiag && Date.now() - lastIdleDiagMs > 90_000) {
        lastIdleDiagMs = Date.now();
        try {
          const d = await getQueueClaimDiagnostics();
          console.warn("[queue-worker] idle diagnostics (AIRDROP_QUEUE_WORKER_DEBUG=1):");
          console.warn(JSON.stringify(d, null, 2));
        } catch (e) {
          console.error("[queue-worker] idle diagnostics failed", e);
        }
      }
      const streak = getConsecutiveEmptyPolls();
      if (streak >= 40 && streak % 20 === 0) {
        try {
          await refreshQueueRuntimeCache();
          const d = await getQueueClaimDiagnostics();
          console.warn(
            `[queue-worker] idle: consecutiveEmptyPolls=${streak} matchingClaimableSql=${d.matchingClaimSql} blockers=${collectQueueClaimBlockers().join("; ") || "none"}`,
          );
          fileLog?.log("warn", "idle_poll_streak", {
            streak,
            matchingClaimSql: d.matchingClaimSql,
          });
        } catch {
          /* ignore */
        }
      }
      if (streak >= 80 && streak % 40 === 0) {
        try {
          const d = await getQueueClaimDiagnostics();
          maybeAlertClaimStarvation(d.matchingClaimSql);
        } catch {
          /* ignore */
        }
      }
      await sleep(queueWorkerPollMs());
      continue;
    }

    const baseParallel = maxParallelTxsPerWave();
    const parallelWave =
      batch.length > 0 && queueAdaptiveParallelEnabled()
        ? Math.max(1, Math.round(baseParallel * (1 - 0.65 * Math.min(1, lastBatchFailRatio))))
        : Math.max(1, baseParallel);

    /** One row per signer per wave — avoids EVM nonce races; multiple signers still run in parallel. */
    const bySigner = new Map<string, ClaimedWalletRow[]>();
    for (const r of batch) {
      const key = `${r.owner.toLowerCase()}:${(r.signerAddress ?? "").toLowerCase()}`;
      if (!bySigner.has(key)) bySigner.set(key, []);
      bySigner.get(key)!.push(r);
    }
    const signerQueues = [...bySigner.values()];

    const chunkGap = interChunkDelayMs();
    let batchOk = 0;
    let batchFail = 0;
    let rr = 0;
    while (signerQueues.some((q) => q.length)) {
      const wave: ClaimedWalletRow[] = [];
      for (let i = 0; i < signerQueues.length && wave.length < parallelWave; i++) {
        const idx = (rr + i) % signerQueues.length;
        const q = signerQueues[idx]!;
        if (q.length) wave.push(q.shift()!);
      }
      if (!wave.length) break;
      rr = (rr + 1) % signerQueues.length;

      const outcomes = await Promise.all(wave.map((row) => processClaimedWalletRow(row)));
      for (const ok of outcomes) {
        if (ok) {
          batchOk++;
          cumulativeOk++;
        } else {
          batchFail++;
          cumulativeFail++;
        }
      }
      if (signerQueues.some((q) => q.length) && chunkGap > 0) await sleep(chunkGap);
    }
    lastBatchFailRatio = batch.length ? batchFail / batch.length : 0;
    const jobIds = [...new Set(batch.map((r) => r.jobId))];
    const activeJobId = jobIds.length === 1 ? jobIds[0]! : null;
    fileLog?.log("metric", "batch_complete", {
      claimed: batch.length,
      ok: batchOk,
      fail: batchFail,
      activeJobId,
    });
    try {
      await upsertWorkerHeartbeat({
        workerId,
        iterations: iteration,
        rowsOk: cumulativeOk,
        rowsFail: cumulativeFail,
        lastBatchSize: batch.length,
        activeJobId,
      });
    } catch {
      /* heartbeat must not kill worker */
    }
    if (interSleep > 0) await sleep(interSleep);
  }

  fileLog?.log("info", "queue_worker_stopped", { workerId, aborted: Boolean(signal?.aborted) });
  await options?.onStopped?.();
}
