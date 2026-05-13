import { NextResponse } from "next/server";
import {
  embeddedNormalizedQueueWorkerEnabled,
  isAirdropQueueV2Enabled,
  isAirdropQueueV2EnvEnabled,
  queueClaimBatchSize,
  queueClaimCandidateLimit,
  queueEffectiveClaimBatchSize,
} from "@/lib/queue/config";
import {
  refreshQueueRuntimeCache,
  setQueueRuntimeFlagsPartial,
  type QueueRuntimeFlags,
} from "@/lib/queue/queue-runtime-settings";
import { getQueueThroughputMetrics } from "@/lib/queue/queue-throughput-metrics";
import {
  globalTxsPerMinuteLimit,
  signerTxsPerMinuteLimit,
  targetTxPerMinute,
  txRateLimitingEnabled,
} from "@/lib/queue/throughput-limits";
import {
  embeddedQueueWorkerActiveLoopCount,
  embeddedQueueWorkerLoopRunning,
  startEmbeddedQueueWorkerIfEligible,
  stopEmbeddedQueueWorker,
} from "@/lib/queue/embedded-queue-lifecycle";
import { requireDistributorSession } from "@/lib/session";

function canToggleQueueControl(sessionAddressLower: string): boolean {
  const raw = process.env.AIRDROP_QUEUE_CONTROL_ADDRESSES?.trim();
  if (!raw) return true;
  const allowed = new Set(
    raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  return allowed.has(sessionAddressLower.toLowerCase());
}

export async function GET(request: Request) {
  const session = await requireDistributorSession(request);
  if (session instanceof NextResponse) return session;

  await refreshQueueRuntimeCache();
  const { getQueueRuntimeFlagsSync } = await import("@/lib/queue/queue-runtime-settings");
  const syncFlags = getQueueRuntimeFlagsSync();

  let metrics = null as Awaited<ReturnType<typeof getQueueThroughputMetrics>> | null;
  try {
    metrics = await getQueueThroughputMetrics();
  } catch {
    metrics = null;
  }
  const signerTxsPerMinute = signerTxsPerMinuteLimit();
  const globalTxsPerMinute = globalTxsPerMinuteLimit();
  const targetTxPerMin = targetTxPerMinute();
  const activeSigners = metrics?.activeSigners ?? 0;
  const estimatedTxPerMin = activeSigners * signerTxsPerMinute;
  const throughputWarning =
    activeSigners > 0 && estimatedTxPerMin < targetTxPerMin
      ? `Estimated capacity (${estimatedTxPerMin}/min from ${activeSigners} active signer(s) × ${signerTxsPerMinute}/min) is below target ${targetTxPerMin}/min. Add signer wallets or raise AIRDROP_SIGNER_TXS_PER_MINUTE (and ensure AIRDROP_GLOBAL_TXS_PER_MINUTE fits).`
      : null;

  return NextResponse.json({
    processingEnabled: syncFlags.processingEnabled,
    normalizedQueueV2: syncFlags.normalizedQueueV2,
    embeddedWorker: syncFlags.embeddedWorker,
    maxParallelTxs: syncFlags.maxParallelTxs,
    maxConcurrentJobs: syncFlags.maxConcurrentJobs,
    embeddedWorkerCount: syncFlags.embeddedWorkerCount,
    configuredClaimBatchSize: queueClaimBatchSize(),
    effectiveClaimBatchSize: queueEffectiveClaimBatchSize(),
    claimCandidateLimit: queueClaimCandidateLimit(),
    embeddedWorkerActiveLoops: embeddedQueueWorkerActiveLoopCount(),
    queueV2Effective: isAirdropQueueV2Enabled(),
    queueV2Env: isAirdropQueueV2EnvEnabled(),
    embeddedWorkerEffective: embeddedNormalizedQueueWorkerEnabled(),
    embeddedWorkerLoopRunning: embeddedQueueWorkerLoopRunning(),
    embeddedEnvOptOut:
      process.env.AIRDROP_EMBEDDED_QUEUE_WORKER?.trim().toLowerCase() === "false" ||
      process.env.AIRDROP_EMBEDDED_QUEUE_WORKER?.trim() === "0",
    databaseConfigured: Boolean(process.env.DATABASE_URL?.trim()),
    globalPausedEnv:
      process.env.AIRDROP_QUEUE_GLOBAL_PAUSED?.trim() === "1" ||
      process.env.AIRDROP_QUEUE_GLOBAL_PAUSED?.trim()?.toLowerCase() === "true",
    canToggle: canToggleQueueControl(session.address),
    throughput: metrics
      ? {
          activeSigners: metrics.activeSigners,
          txPerMinuteLast1: metrics.txPerMinute1,
          txPerMinuteLast5Avg: metrics.txPerMinute5,
          failedTxPerMinuteLast1: metrics.failedTxPerMinute1,
          signerTxsPerMinute,
          globalTxsPerMinute,
          targetTxPerMinute: targetTxPerMin,
          estimatedTxPerMin,
          throughputWarning,
          txRateLimitingEnabled: txRateLimitingEnabled(),
        }
      : null,
  });
}

export async function PATCH(request: Request) {
  const session = await requireDistributorSession(request);
  if (session instanceof NextResponse) return session;
  if (!canToggleQueueControl(session.address)) {
    return NextResponse.json({ error: "Forbidden — set AIRDROP_QUEUE_CONTROL_ADDRESSES to allow this wallet" }, { status: 403 });
  }

  let body: {
    processingEnabled?: unknown;
    normalizedQueueV2?: unknown;
    embeddedWorker?: unknown;
    maxParallelTxs?: unknown;
    maxConcurrentJobs?: unknown;
    embeddedWorkerCount?: unknown;
    action?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const partial: Partial<QueueRuntimeFlags> = {};
  if (typeof body.processingEnabled === "boolean") partial.processingEnabled = body.processingEnabled;
  if (typeof body.normalizedQueueV2 === "boolean") partial.normalizedQueueV2 = body.normalizedQueueV2;
  if (typeof body.embeddedWorker === "boolean") partial.embeddedWorker = body.embeddedWorker;
  if (body.maxParallelTxs !== undefined && body.maxParallelTxs !== null) {
    const n = typeof body.maxParallelTxs === "number" ? body.maxParallelTxs : Number(body.maxParallelTxs);
    if (Number.isFinite(n)) partial.maxParallelTxs = n;
  }
  if (body.maxConcurrentJobs !== undefined && body.maxConcurrentJobs !== null) {
    const n = typeof body.maxConcurrentJobs === "number" ? body.maxConcurrentJobs : Number(body.maxConcurrentJobs);
    if (Number.isFinite(n)) partial.maxConcurrentJobs = n;
  }
  if (body.embeddedWorkerCount !== undefined && body.embeddedWorkerCount !== null) {
    const n =
      typeof body.embeddedWorkerCount === "number" ? body.embeddedWorkerCount : Number(body.embeddedWorkerCount);
    if (Number.isFinite(n)) partial.embeddedWorkerCount = n;
  }

  if (Object.keys(partial).length === 0) {
    return NextResponse.json({ error: "No known fields to update" }, { status: 400 });
  }

  await refreshQueueRuntimeCache();
  const { getQueueRuntimeFlagsSync } = await import("@/lib/queue/queue-runtime-settings");

  const next = await setQueueRuntimeFlagsPartial(partial);

  const embeddedSettingsChanged =
    partial.embeddedWorker !== undefined || partial.embeddedWorkerCount !== undefined;
  if (embeddedSettingsChanged) {
    if (next.embeddedWorker && embeddedNormalizedQueueWorkerEnabled()) {
      startEmbeddedQueueWorkerIfEligible();
    } else {
      stopEmbeddedQueueWorker();
    }
  }

  return NextResponse.json({
    ok: true,
    processingEnabled: next.processingEnabled,
    normalizedQueueV2: next.normalizedQueueV2,
    embeddedWorker: next.embeddedWorker,
    maxParallelTxs: next.maxParallelTxs,
    maxConcurrentJobs: next.maxConcurrentJobs,
    embeddedWorkerCount: next.embeddedWorkerCount,
    configuredClaimBatchSize: queueClaimBatchSize(),
    effectiveClaimBatchSize: queueEffectiveClaimBatchSize(),
    claimCandidateLimit: queueClaimCandidateLimit(),
    embeddedWorkerActiveLoops: embeddedQueueWorkerActiveLoopCount(),
    queueV2Effective: isAirdropQueueV2Enabled(),
    embeddedWorkerEffective: embeddedNormalizedQueueWorkerEnabled(),
    embeddedWorkerLoopRunning: embeddedQueueWorkerLoopRunning(),
  });
}
