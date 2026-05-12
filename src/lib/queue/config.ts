/** Normalized PostgreSQL queue (SKIP LOCKED workers). Enable with AIRDROP_QUEUE_V2=true */

import { getQueueRuntimeFlagsSync } from "./queue-runtime-settings";

const { ensureDatabaseUrl } = require("../../../database-url.js") as { ensureDatabaseUrl: () => void };

/** Env-only — deployment still requires this on for queue features to be eligible. */
export function isAirdropQueueV2EnvEnabled(): boolean {
  const v = process.env.AIRDROP_QUEUE_V2?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/** Effective normalized-queue mode: env on AND dashboard DB flag (when loaded). */
export function isAirdropQueueV2Enabled(): boolean {
  if (!isAirdropQueueV2EnvEnabled()) return false;
  return getQueueRuntimeFlagsSync().normalizedQueueV2;
}

export function queueWorkerId(): string {
  const raw = process.env.AIRDROP_WORKER_ID?.trim();
  if (raw) return raw.slice(0, 64);
  const pid = typeof process.pid === "number" ? String(process.pid) : "0";
  return `w-${pid}`;
}

function envInt(name: string, fallback: number, min: number, max: number): number {
  const n = parseInt(process.env[name]?.trim() ?? "", 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Wallets claimed per worker transaction (default 48; cap 500). */
export function queueClaimBatchSize(): number {
  return envInt("AIRDROP_QUEUE_BATCH_SIZE", 48, 1, 500);
}

/** Rows per INSERT when creating a job (default 1000). */
export function queueBulkInsertChunk(): number {
  return envInt("AIRDROP_QUEUE_BULK_CHUNK", 1000, 50, 10_000);
}

/** Extra attempts after the first try (default 5 → 6 total attempts per wallet row). */
export function queueMaxRetries(): number {
  return envInt("AIRDROP_QUEUE_MAX_RETRIES", 5, 0, 100);
}

/** Total send attempts allowed per wallet row before permanent failure. */
export function queueMaxAttempts(): number {
  return queueMaxRetries() + 1;
}

/** Reset stale `processing` rows after this age (default 10 minutes). */
export function queueStaleProcessingMs(): number {
  return envInt("AIRDROP_QUEUE_STALE_PROCESSING_MS", 10 * 60_000, 30_000, 24 * 60 * 60_000);
}

export function queueWorkerPollMs(): number {
  return envInt("AIRDROP_QUEUE_WORKER_POLL_MS", 500, 50, 60_000);
}

/** Extra sleep after each claimed batch (reduces RPC/DB pressure under load). Default 0. */
export function queueWorkerInterBatchSleepMs(): number {
  return envInt("AIRDROP_QUEUE_WORKER_INTER_BATCH_SLEEP_MS", 0, 0, 300_000);
}

/** When true, workers claim nothing (global drain-stop). Checked each poll. */
export function queueGlobalPaused(): boolean {
  const v = process.env.AIRDROP_QUEUE_GLOBAL_PAUSED?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/**
 * Human-readable reasons the embedded worker cannot start (empty array = OK).
 * Call after `refreshQueueRuntimeCache()` so DB-backed flags match Postgres / Redis cache.
 */
export function collectEmbeddedWorkerBlockers(): string[] {
  try {
    ensureDatabaseUrl();
  } catch (e) {
    return [`ensureDatabaseUrl failed: ${e instanceof Error ? e.message : String(e)}`];
  }
  const reasons: string[] = [];
  if (!isAirdropQueueV2Enabled()) {
    if (!isAirdropQueueV2EnvEnabled()) reasons.push("AIRDROP_QUEUE_V2 is not true");
    else reasons.push("normalized_queue_v2 is off in queue_runtime_settings (id=1)");
  }
  const v = process.env.AIRDROP_EMBEDDED_QUEUE_WORKER?.trim().toLowerCase();
  if (v === "0" || v === "false" || v === "no") {
    reasons.push("AIRDROP_EMBEDDED_QUEUE_WORKER=false");
  }
  if (!process.env.DATABASE_URL?.trim()) {
    reasons.push(
      "DATABASE_URL is empty — set DATABASE_URL or DB_HOST, DB_USER, DB_DATABASE (and DB_PASSWORD); ensure .env is loaded (server.js uses @next/env)",
    );
  }
  if (!getQueueRuntimeFlagsSync().embeddedWorker) {
    reasons.push("embedded_worker is off in queue_runtime_settings (id=1)");
  }
  return reasons;
}

/**
 * Start the normalized `job_wallets` worker inside the same Node process as Next (`npm run dev`, `next start`, `node server.js`).
 * Default **on** when `AIRDROP_QUEUE_V2` is enabled and `DATABASE_URL` is set.
 * Set `AIRDROP_EMBEDDED_QUEUE_WORKER=false` to use only a separate `npm run worker:queue` (recommended if you run **multiple** app replicas).
 */
export function embeddedNormalizedQueueWorkerEnabled(): boolean {
  return collectEmbeddedWorkerBlockers().length === 0;
}

/**
 * Reasons {@link claimWalletBatch} returns no rows before hitting SQL (same checks as the worker loop).
 * Call after {@link refreshQueueRuntimeCache} so flags match Postgres / Redis cache.
 */
export function collectQueueClaimBlockers(): string[] {
  const reasons: string[] = [];
  if (!isAirdropQueueV2Enabled()) {
    if (!isAirdropQueueV2EnvEnabled()) reasons.push("AIRDROP_QUEUE_V2 is not true");
    else reasons.push("normalized_queue_v2 is off in queue_runtime_settings (id=1)");
  }
  if (queueGlobalPaused()) reasons.push("AIRDROP_QUEUE_GLOBAL_PAUSED is true");
  if (!getQueueRuntimeFlagsSync().processingEnabled) {
    reasons.push("processing_enabled is off — turn on queue processing in Dashboard → Queue worker");
  }
  return reasons;
}

/**
 * Reduce parallel TX wave size when the previous batch had many failures (RPC pressure relief).
 * Default false.
 */
export function queueAdaptiveParallelEnabled(): boolean {
  const v = process.env.AIRDROP_QUEUE_ADAPTIVE_PARALLEL?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/**
 * Milliseconds to wait after retry attempt `retryCount` (1-based after increment).
 * Default ladder: 5s → 30s → 5m → stays at last step.
 * Override: AIRDROP_QUEUE_RETRY_BACKOFF_MS=5000,30000,300000,3600000
 */
export function queueRetryBackoffStepsMs(): number[] {
  const raw = process.env.AIRDROP_QUEUE_RETRY_BACKOFF_MS?.trim();
  if (raw) {
    const parts = raw.split(",").map((x) => parseInt(x.trim(), 10));
    const ok = parts.filter((n) => Number.isFinite(n) && n >= 0);
    if (ok.length) return ok;
  }
  return [5000, 30_000, 300_000];
}

/** Delay before a failed wallet row can be claimed again (`retry_count` is after increment). */
export function queueRetryBackoffMsForRetryCount(retryCountAfterIncrement: number): number {
  const steps = queueRetryBackoffStepsMs();
  const idx = Math.max(0, retryCountAfterIncrement - 1);
  return steps[Math.min(idx, steps.length - 1)] ?? steps[steps.length - 1]!;
}
