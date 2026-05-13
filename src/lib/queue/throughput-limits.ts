/** Env-driven caps for queue send throughput (see docs/coolify-queue-throughput.md). */

function envInt(name: string, fallback: number, min: number, max: number): number {
  const n = parseInt(process.env[name]?.trim() ?? "", 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** When false, skip Redis/PG rate waits before each send (nonce + claim rules still apply). */
export function txRateLimitingEnabled(): boolean {
  const v = process.env.AIRDROP_TX_RATE_LIMITING?.trim().toLowerCase();
  if (v === "0" || v === "false" || v === "no") return false;
  return true;
}

/** Max completed sends per signer per rolling minute (default 10). */
export function signerTxsPerMinuteLimit(): number {
  return envInt("AIRDROP_SIGNER_TXS_PER_MINUTE", 10, 1, 600);
}

/** Max completed sends per rolling minute across all signers (default 1000). */
export function globalTxsPerMinuteLimit(): number {
  return envInt("AIRDROP_GLOBAL_TXS_PER_MINUTE", 1000, 1, 100_000);
}

/** Desired throughput for dashboard warning (defaults to global cap). */
export function targetTxPerMinute(): number {
  const raw = process.env.AIRDROP_TARGET_TX_PER_MINUTE?.trim();
  if (raw) {
    const n = parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 1) return Math.min(100_000, n);
  }
  return globalTxsPerMinuteLimit();
}
