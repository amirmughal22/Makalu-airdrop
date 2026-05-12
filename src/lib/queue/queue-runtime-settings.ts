import type { RowDataPacket } from "mysql2";
import { getMysqlPool } from "../mysql";
import { observeRuntimeRefreshSequence } from "./queue-worker-liveness";

export type QueueRuntimeFlags = {
  processingEnabled: boolean;
  normalizedQueueV2: boolean;
  embeddedWorker: boolean;
  /** Parallel transfers per wave (1–20). */
  maxParallelTxs: number;
  /** Legacy embedded job runner: concurrent jobs in this process (1–32). */
  maxConcurrentJobs: number;
  /** Concurrent normalized-queue loops in this Node process when embedded worker is on (1–10). */
  embeddedWorkerCount: number;
};

const TTL_MS = 2000;

const DEFAULT_FLAGS: QueueRuntimeFlags = {
  processingEnabled: true,
  normalizedQueueV2: true,
  embeddedWorker: true,
  maxParallelTxs: 3,
  maxConcurrentJobs: 5,
  embeddedWorkerCount: 1,
};

/** Monotonic counter incremented on each successful DB read — workers can detect stale observers. */
let refreshSequence = 0;

/** Full flags row + timestamps. `loadedFromDbFallback` true when catch path or missing row used defaults. */
let cache:
  | (QueueRuntimeFlags & {
      at: number;
      dbUpdatedAtMs: number | null;
      loadedFromDbFallback: boolean;
    })
  | null = null;

export function getQueueRuntimeFlagsSync(): QueueRuntimeFlags {
  const pick = (): QueueRuntimeFlags =>
    cache
      ? {
          processingEnabled: cache.processingEnabled,
          normalizedQueueV2: cache.normalizedQueueV2,
          embeddedWorker: cache.embeddedWorker,
          maxParallelTxs: cache.maxParallelTxs,
          maxConcurrentJobs: cache.maxConcurrentJobs,
          embeddedWorkerCount: cache.embeddedWorkerCount,
        }
      : { ...DEFAULT_FLAGS };

  if (cache && Date.now() - cache.at < TTL_MS) {
    return pick();
  }
  return pick();
}

export type QueueRuntimeCacheMeta = {
  refreshSequence: number;
  lastRefreshAtMs: number;
  dbSettingsUpdatedAtMs: number | null;
  ageMsSinceRefresh: number;
  loadedFromDbFallback: boolean;
};

export function getQueueRuntimeCacheMeta(): QueueRuntimeCacheMeta {
  const now = Date.now();
  const lastAt = cache?.at ?? 0;
  return {
    refreshSequence,
    lastRefreshAtMs: lastAt,
    dbSettingsUpdatedAtMs: cache?.dbUpdatedAtMs ?? null,
    ageMsSinceRefresh: lastAt > 0 ? now - lastAt : Number.POSITIVE_INFINITY,
    loadedFromDbFallback: cache?.loadedFromDbFallback ?? true,
  };
}

export async function refreshQueueRuntimeCache(): Promise<void> {
  try {
    const pool = await getMysqlPool();
    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT processing_enabled, normalized_queue_v2, embedded_worker, max_parallel_txs, max_concurrent_jobs, embedded_worker_count,
              UNIX_TIMESTAMP(updated_at) * 1000 AS db_updated_ms
       FROM queue_runtime_settings WHERE id = 1`,
    );
    const row = rows[0] as {
      processing_enabled?: number;
      normalized_queue_v2?: number;
      embedded_worker?: number;
      max_parallel_txs?: number;
      max_concurrent_jobs?: number;
      embedded_worker_count?: number;
      db_updated_ms?: string | number | null;
    } | undefined;
    if (!row) {
      refreshSequence++;
      cache = {
        ...DEFAULT_FLAGS,
        at: Date.now(),
        dbUpdatedAtMs: null,
        loadedFromDbFallback: true,
      };
      observeRuntimeRefreshSequence(refreshSequence);
      return;
    }
    const mp = clampParallel(Number(row.max_parallel_txs ?? DEFAULT_FLAGS.maxParallelTxs));
    const mj = clampConcurrentJobs(Number(row.max_concurrent_jobs ?? DEFAULT_FLAGS.maxConcurrentJobs));
    const ew = clampEmbeddedWorkerCount(Number(row.embedded_worker_count ?? DEFAULT_FLAGS.embeddedWorkerCount));
    const dbMsRaw = row.db_updated_ms;
    const dbUpdatedAtMs =
      dbMsRaw != null && String(dbMsRaw).trim() !== ""
        ? Math.round(Number(dbMsRaw))
        : null;
    refreshSequence++;
    cache = {
      processingEnabled: Boolean(Number(row.processing_enabled ?? 1)),
      normalizedQueueV2: Boolean(Number(row.normalized_queue_v2 ?? 1)),
      embeddedWorker: Boolean(Number(row.embedded_worker ?? 1)),
      maxParallelTxs: mp,
      maxConcurrentJobs: mj,
      embeddedWorkerCount: ew,
      at: Date.now(),
      dbUpdatedAtMs: Number.isFinite(dbUpdatedAtMs ?? NaN) ? dbUpdatedAtMs : null,
      loadedFromDbFallback: false,
    };
    observeRuntimeRefreshSequence(refreshSequence);
  } catch {
    refreshSequence++;
    cache = {
      ...DEFAULT_FLAGS,
      at: Date.now(),
      dbUpdatedAtMs: null,
      loadedFromDbFallback: true,
    };
    observeRuntimeRefreshSequence(refreshSequence);
  }
}

function clampParallel(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_FLAGS.maxParallelTxs;
  return Math.min(20, Math.max(1, Math.floor(n)));
}

function clampConcurrentJobs(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_FLAGS.maxConcurrentJobs;
  return Math.min(32, Math.max(1, Math.floor(n)));
}

function clampEmbeddedWorkerCount(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_FLAGS.embeddedWorkerCount;
  return Math.min(10, Math.max(1, Math.floor(n)));
}

export function invalidateQueueRuntimeCache(): void {
  cache = null;
}

export async function getQueueProcessingEnabledFromDb(): Promise<boolean> {
  await refreshQueueRuntimeCache();
  return getQueueRuntimeFlagsSync().processingEnabled;
}

/** Merge with current DB-backed flags and persist. */
export async function setQueueRuntimeFlagsPartial(partial: Partial<QueueRuntimeFlags>): Promise<QueueRuntimeFlags> {
  await refreshQueueRuntimeCache();
  const cur = getQueueRuntimeFlagsSync();
  const next: QueueRuntimeFlags = {
    processingEnabled: partial.processingEnabled ?? cur.processingEnabled,
    normalizedQueueV2: partial.normalizedQueueV2 ?? cur.normalizedQueueV2,
    embeddedWorker: partial.embeddedWorker ?? cur.embeddedWorker,
    maxParallelTxs:
      partial.maxParallelTxs !== undefined ? clampParallel(partial.maxParallelTxs) : cur.maxParallelTxs,
    maxConcurrentJobs:
      partial.maxConcurrentJobs !== undefined ? clampConcurrentJobs(partial.maxConcurrentJobs) : cur.maxConcurrentJobs,
    embeddedWorkerCount:
      partial.embeddedWorkerCount !== undefined
        ? clampEmbeddedWorkerCount(partial.embeddedWorkerCount)
        : cur.embeddedWorkerCount,
  };
  const pool = await getMysqlPool();
  await pool.execute(
    `INSERT INTO queue_runtime_settings (
       id, processing_enabled, normalized_queue_v2, embedded_worker, max_parallel_txs, max_concurrent_jobs, embedded_worker_count
     ) VALUES (1, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       processing_enabled = VALUES(processing_enabled),
       normalized_queue_v2 = VALUES(normalized_queue_v2),
       embedded_worker = VALUES(embedded_worker),
       max_parallel_txs = VALUES(max_parallel_txs),
       max_concurrent_jobs = VALUES(max_concurrent_jobs),
       embedded_worker_count = VALUES(embedded_worker_count),
       updated_at = CURRENT_TIMESTAMP(3)`,
    [
      next.processingEnabled ? 1 : 0,
      next.normalizedQueueV2 ? 1 : 0,
      next.embeddedWorker ? 1 : 0,
      next.maxParallelTxs,
      next.maxConcurrentJobs,
      next.embeddedWorkerCount,
    ],
  );
  invalidateQueueRuntimeCache();
  await refreshQueueRuntimeCache();
  return getQueueRuntimeFlagsSync();
}
