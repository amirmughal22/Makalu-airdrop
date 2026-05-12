import { walletGenerationPollLoop } from "./generated-wallet-generation-runner";

/**
 * Runs wallet batch materialization inside the Next.js / Node process (no separate `wallets:generate` container).
 * Opt out with `AIRDROP_EMBEDDED_WALLET_GENERATION=false` if you run a dedicated generator elsewhere.
 */
let embeddedWalletGenStarted = false;

export function embeddedWalletGenerationEnabled(): boolean {
  if (process.env.NEXT_RUNTIME === "edge") return false;
  if (process.env.AIRDROP_EMBEDDED_WALLET_GENERATION === "false") return false;
  if (!process.env.DATABASE_URL?.trim()) return false;
  return true;
}

/** Idempotent — safe to call from instrumentation and after API batch create. */
export function startEmbeddedWalletGenerationIfEligible(): void {
  if (!embeddedWalletGenerationEnabled()) return;
  if (embeddedWalletGenStarted) return;
  embeddedWalletGenStarted = true;

  const yieldMs = Math.min(500, Math.max(0, parseInt(process.env.AIRDROP_WALLET_GEN_EMBEDDED_YIELD_MS ?? "3", 10) || 0));

  void walletGenerationPollLoop({
    logPrefix: "[embedded wallets:generate]",
    yieldMsAfterChunk: yieldMs,
  }).catch((e) => {
    console.error("[embedded wallets:generate] loop exited:", e);
    embeddedWalletGenStarted = false;
  });
}
