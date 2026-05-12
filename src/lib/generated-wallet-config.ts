function envInt(name: string, fallback: number, min: number, max: number): number {
  const n = parseInt(process.env[name]?.trim() ?? "", 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Rows inserted per INSERT inside the wallet generation worker (default 5000; clamp 100–5000 via env). */
export function walletGenerationInsertChunk(): number {
  return envInt("WALLET_GENERATION_BATCH_SIZE", 5000, 100, 5000);
}

/** Max wallets per batch row / per generation request (default 1_000_000). */
export function walletGenerationMaxWallets(): number {
  return envInt("WALLET_GENERATION_MAX_WALLETS", 1_000_000, 1, 10_000_000);
}
