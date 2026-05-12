import { getQueueRuntimeFlagsSync } from "./queue/queue-runtime-settings";

/** True when the error often clears after backoff (RPC / reverse proxy / rate limits). */
export function isTransientRpcError(e: unknown): boolean {
  const s = (e instanceof Error ? e.message : String(e ?? "")).toLowerCase();
  return (
    s.includes("503") ||
    s.includes("502") ||
    s.includes("504") ||
    s.includes("429") ||
    s.includes("temporarily unavailable") ||
    s.includes("service unavailable") ||
    s.includes("bad gateway") ||
    s.includes("gateway timeout") ||
    s.includes("rate limit") ||
    s.includes("too many requests") ||
    s.includes("timeout") ||
    s.includes("fetch failed") ||
    s.includes("econnreset") ||
    s.includes("etimedout") ||
    s.includes("econnrefused") ||
    s.includes("non-200") ||
    s.includes("network request failed")
  );
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Max simultaneous eth_send* per wave (limits RPC/nginx load). Dashboard 1–20; env fallback. */
export function maxParallelTxsPerWave(): number {
  const db = getQueueRuntimeFlagsSync().maxParallelTxs;
  if (typeof db === "number" && db >= 1 && db <= 20) return db;
  return envInt("AIRDROP_MAX_PARALLEL_TXS", 6, 1, 20);
}

/** Max airdrop jobs running at once in this process. Dashboard 1–32; env fallback up to 64. */
export function maxConcurrentAirdropJobs(): number {
  const db = getQueueRuntimeFlagsSync().maxConcurrentJobs;
  if (typeof db === "number" && db >= 1 && db <= 32) return db;
  return envInt("AIRDROP_MAX_CONCURRENT_JOBS", 5, 1, 64);
}

/** Pause between parallel chunks within one wave (ms). Default 300. */
export function interChunkDelayMs(): number {
  return envInt("AIRDROP_INTER_CHUNK_MS", 300, 0, 10_000);
}

function envInt(name: string, fallback: number, min: number, max: number): number {
  const n = parseInt(process.env[name]?.trim() ?? "", 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * Retries `op` on transient RPC/proxy errors (503, timeouts, etc.).
 * Tuned via AIRDROP_RPC_RETRY_ATTEMPTS (default 6) and AIRDROP_RPC_RETRY_BASE_MS (default 700).
 */
export async function withTransientRpcRetries<T>(op: () => Promise<T>, logLabel: string): Promise<T> {
  const max = envInt("AIRDROP_RPC_RETRY_ATTEMPTS", 6, 1, 12);
  const baseMs = envInt("AIRDROP_RPC_RETRY_BASE_MS", 700, 100, 30_000);
  let last: unknown;
  for (let attempt = 1; attempt <= max; attempt++) {
    try {
      return await op();
    } catch (e) {
      last = e;
      if (!isTransientRpcError(e) || attempt === max) throw e;
      const delay = baseMs * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);
      console.warn(`[rpc-retry] ${logLabel} attempt ${attempt}/${max} failed, wait ${delay}ms`, e);
      await sleep(delay);
    }
  }
  throw last;
}
