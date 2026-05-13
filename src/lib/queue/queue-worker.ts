import { MAKALU_CHAIN_ID_DECIMAL } from "../chain";
import { executeEvmTransfer, readErc20Decimals } from "../transfers/fund-transfer-service";
import { humanizeAirdropError } from "../humanize-airdrop-error";
import { interChunkDelayMs, maxParallelTxsPerWave, sleep } from "../rpc-retry";
import {
  claimWalletBatch,
  recordWalletFailure,
  recordWalletSuccess,
  reconcileAllJobStatusesFromWallets,
  reconcileStaleProcessingRows,
} from "./job-queue-repo";
import {
  claimFundTransferBatch,
  recordFundTransferFailure,
  recordFundTransferSuccess,
  reconcileStaleFundTransferProcessing,
  type ClaimedFundTransferRow,
} from "./fund-transfer-queue-repo";
import { acquireTxSendBudget } from "./tx-rate-limiter";
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

async function erc20DecimalsCachedFund(row: ClaimedFundTransferRow): Promise<number> {
  if (row.mode !== "erc20" || !row.tokenAddress) return 18;
  const key = `${row.chainId}:${(row.tokenAddress ?? "").toLowerCase()}`;
  const hit = decimalsCache.get(key);
  if (hit != null) return hit;
  const d = await readErc20Decimals(
    row.tokenAddress as `0x${string}`,
    row.chainId || MAKALU_CHAIN_ID_DECIMAL,
  );
  decimalsCache.set(key, d);
  return d;
}

export async function processClaimedFundTransferRow(row: ClaimedFundTransferRow): Promise<boolean> {
  if (!row.signerAddress) {
    await recordFundTransferFailure(row.id, "Missing signer_address on fund transfer row", row.retryCount);
    return false;
  }
  try {
    const tokenDecimals = await erc20DecimalsCachedFund(row);
    const { txHash, rpcUrl } = await executeEvmTransfer({
      mode: row.mode,
      tokenAddress: row.tokenAddress,
      chainId: row.chainId,
      owner: row.owner,
      signerAddress: row.signerAddress,
      recipient: row.targetWalletAddress as `0x${string}`,
      amount: row.amount,
      tokenDecimals: row.mode === "erc20" ? tokenDecimals : undefined,
    });
    await recordFundTransferSuccess(row.id, txHash, rpcUrl);
    return true;
  } catch (e) {
    await recordFundTransferFailure(row.id, humanizeAirdropError(e), row.retryCount);
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
  let lastClaimZeroLogMs = 0;
  const CLAIM_ZERO_LOG_MS = 30_000;
  const verboseLoop =
    process.env.AIRDROP_QUEUE_WORKER_DEBUG?.trim() === "1" ||
    process.env.AIRDROP_QUEUE_WORKER_DEBUG?.trim()?.toLowerCase() === "true";

  const idleDiag =
    process.env.AIRDROP_QUEUE_WORKER_DEBUG?.trim() === "1" ||
    process.env.AIRDROP_QUEUE_WORKER_DEBUG?.trim()?.toLowerCase() === "true";

  async function pulseHeartbeat(lastBatchSize: number): Promise<void> {
    try {
      await upsertWorkerHeartbeat({
        workerId,
        iterations: iteration,
        rowsOk: cumulativeOk,
        rowsFail: cumulativeFail,
        lastBatchSize,
        activeJobId: null,
      });
    } catch (e) {
      console.error("[queue-worker] heartbeat upsert failed", e instanceof Error ? e.stack ?? e.message : e);
    }
  }

  initWorkerLivenessClock();
  console.info(
    JSON.stringify({
      event: "queue_worker_started",
      workerId: workerId.slice(0, 64),
      pollMs: queueWorkerPollMs(),
      verboseLoop,
    }),
  );
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
    if (verboseLoop || iteration === 1 || iteration % 25 === 0) {
      console.info(JSON.stringify({ event: "queue_worker_loop_tick", iteration, workerId: workerId.slice(0, 64) }));
    }
    try {
      const n = await reconcileStaleProcessingRows();
      if (n > 0) {
        console.log(`[queue-worker] reconciled ${n} stale processing row(s)`);
        try {
          const jr = await reconcileAllJobStatusesFromWallets();
          if (jr > 0) console.log(`[queue-worker] reconciled ${jr} job status row(s) after stale wallet reset`);
        } catch (e) {
          console.error("[queue-worker] job status reconcile after stale reset failed", e);
        }
      }
      try {
        const nf = await reconcileStaleFundTransferProcessing();
        if (nf > 0) console.log(`[queue-worker] reconciled ${nf} stale fund transfer row(s)`);
      } catch (e) {
        console.error("[queue-worker] fund transfer stale reconciliation failed", e);
      }
    } catch (e) {
      console.error("[queue-worker] stale reconciliation failed", e);
    }

    let batch: ClaimedWalletRow[] = [];
    const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
    if (verboseLoop) {
      console.info(JSON.stringify({ event: "queue_worker_before_claim", iteration, workerId: workerId.slice(0, 64) }));
    }
    try {
      batch = await claimWalletBatch(workerId);
    } catch (e) {
      console.error("[queue-worker] claim exception", e instanceof Error ? e.stack ?? e.message : e);
      await pulseHeartbeat(0);
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

    console.info(
      JSON.stringify({
        event: "queue_worker_claim_result",
        iteration,
        workerId: workerId.slice(0, 64),
        claimed: batch.length,
        claimLatencyMs: Math.round(claimLatencyMs),
      }),
    );

    if (batch.length) {
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

      for (const row of wave) {
        await acquireTxSendBudget(row.signerAddress!);
      }

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
    } catch (e) {
      console.error("[queue-worker] heartbeat upsert failed after batch", e instanceof Error ? e.stack ?? e.message : e);
    }
    try {
      const jr = await reconcileAllJobStatusesFromWallets();
      if (jr > 0) {
        console.log(`[queue-worker] reconciled ${jr} parent job status row(s) after batch`);
      }
    } catch (e) {
      console.error("[queue-worker] reconcileAllJobStatusesFromWallets failed", e);
    }
    }

    let fundBatch: ClaimedFundTransferRow[] = [];
    try {
      fundBatch = await claimFundTransferBatch(workerId);
    } catch (e) {
      console.error("[queue-worker] fund transfer claim exception", e instanceof Error ? e.stack ?? e.message : e);
    }

    if (!batch.length && !fundBatch.length) {
      if (iteration % runtimeCheckEvery === 0) {
        await refreshQueueRuntimeCache();
        const blockers = collectQueueClaimBlockers();
        if (blockers.length > 0) {
          const msg = blockers.join(" | ");
          console.error(
            JSON.stringify({
              event: "queue_worker_fatal_exit",
              reason: "runtime_queue_blocked",
              blockers,
              workerId: workerId.slice(0, 64),
            }),
          );
          console.error("[queue-worker] Runtime queue block — exiting:", msg);
          fileLog?.log("error", "runtime_queue_blocked", { blockers });
          process.exit(1);
        }
      }

      if (Number.isFinite(idleExitPolls) && idleExitPolls > 0 && getConsecutiveEmptyPolls() >= idleExitPolls) {
        console.warn(
          JSON.stringify({
            event: "queue_worker_fatal_exit",
            reason: "idle_exit_threshold",
            polls: idleExitPolls,
            workerId: workerId.slice(0, 64),
          }),
        );
        console.warn(
          `[queue-worker] Exiting after ${idleExitPolls} empty polls (AIRDROP_QUEUE_WORKER_IDLE_EXIT_AFTER_POLLS).`,
        );
        fileLog?.log("warn", "idle_exit_threshold", { polls: idleExitPolls });
        process.exit(0);
      }

      const nowMs = Date.now();
      if (nowMs - lastClaimZeroLogMs >= CLAIM_ZERO_LOG_MS) {
        lastClaimZeroLogMs = nowMs;
        const blockers = collectQueueClaimBlockers();
        let extra: Record<string, unknown> = {};
        try {
          await refreshQueueRuntimeCache();
          const d = await getQueueClaimDiagnostics();
          extra = {
            matchingClaimSql: d.matchingClaimSql,
            pendingBlockedByJobState: d.pendingBlockedByJobState,
            pendingBackoffFuture: d.pendingBackoffFuture,
            pendingRetryCap: d.pendingRetryCap,
            pendingButDraftJob: d.pendingButDraftJob,
          };
        } catch (err) {
          extra = { diagnosticsError: err instanceof Error ? err.message : String(err) };
        }
        console.warn(
          JSON.stringify({
            event: "queue_worker_claim_zero",
            iteration,
            workerId: workerId.slice(0, 64),
            blockers: blockers.length ? blockers : ["none"],
            consecutiveEmptyPolls: getConsecutiveEmptyPolls(),
            ...extra,
          }),
        );
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
      await pulseHeartbeat(0);
      await sleep(queueWorkerPollMs());
      continue;
    }

    if (fundBatch.length > 0) {
      const baseParallelFt = maxParallelTxsPerWave();
      const parallelWaveFt =
        fundBatch.length > 0 && queueAdaptiveParallelEnabled()
          ? Math.max(1, Math.round(baseParallelFt * (1 - 0.65 * Math.min(1, lastBatchFailRatio))))
          : Math.max(1, baseParallelFt);
      const bySignerFt = new Map<string, ClaimedFundTransferRow[]>();
      for (const r of fundBatch) {
        const key = `${r.owner.toLowerCase()}:${(r.signerAddress ?? "").toLowerCase()}`;
        if (!bySignerFt.has(key)) bySignerFt.set(key, []);
        bySignerFt.get(key)!.push(r);
      }
      const signerQueuesFt = [...bySignerFt.values()];
      const chunkGapFt = interChunkDelayMs();
      let fundOk = 0;
      let fundFail = 0;
      let rrFt = 0;
      while (signerQueuesFt.some((q) => q.length)) {
        const wave: ClaimedFundTransferRow[] = [];
        for (let i = 0; i < signerQueuesFt.length && wave.length < parallelWaveFt; i++) {
          const idx = (rrFt + i) % signerQueuesFt.length;
          const q = signerQueuesFt[idx]!;
          if (q.length) wave.push(q.shift()!);
        }
        if (!wave.length) break;
        rrFt = (rrFt + 1) % signerQueuesFt.length;
        for (const row of wave) {
          await acquireTxSendBudget(row.signerAddress!);
        }
        const outcomes = await Promise.all(wave.map((row) => processClaimedFundTransferRow(row)));
        for (const ok of outcomes) {
          if (ok) {
            fundOk++;
            cumulativeOk++;
          } else {
            fundFail++;
            cumulativeFail++;
          }
        }
        if (signerQueuesFt.some((q) => q.length) && chunkGapFt > 0) await sleep(chunkGapFt);
      }
      fileLog?.log("metric", "fund_transfer_batch_complete", {
        claimed: fundBatch.length,
        ok: fundOk,
        fail: fundFail,
      });
      try {
        await upsertWorkerHeartbeat({
          workerId,
          iterations: iteration,
          rowsOk: cumulativeOk,
          rowsFail: cumulativeFail,
          lastBatchSize: fundBatch.length,
          activeJobId: null,
        });
      } catch (e) {
        console.error("[queue-worker] heartbeat upsert failed after fund batch", e instanceof Error ? e.stack ?? e.message : e);
      }
    }

    if (interSleep > 0 && (batch.length > 0 || fundBatch.length > 0)) await sleep(interSleep);
  }

  fileLog?.log("info", "queue_worker_stopped", { workerId, aborted: Boolean(signal?.aborted) });
  await options?.onStopped?.();
}
