/**
 * Optional standalone process: fills `generated_wallets` for pending / resumable batches.
 * Same logic as the in-app embedded loop (`startEmbeddedWalletGenerationIfEligible` in `instrumentation.ts`).
 *
 *   npm run wallets:generate
 *
 * Use when `AIRDROP_EMBEDDED_WALLET_GENERATION=false` or you want one dedicated generator with a lower DB pool limit.
 *
 * Env: DATABASE_URL, WALLET_GENERATION_BATCH_SIZE (optional). If `AIRDROP_DB_CONNECTION_LIMIT` is unset, this script sets it to **4** after loading `.env` to reduce `max_connections` pressure.
 */
import { bootstrapProductionEnv, assertDatabaseConfigured } from "../src/lib/queue/production-env";
import { walletGenerationPollLoop } from "../src/lib/generated-wallet-generation-runner";

const PROJECT_ROOT = process.cwd();

void (async () => {
  try {
    bootstrapProductionEnv(PROJECT_ROOT);
    if (!process.env.AIRDROP_DB_CONNECTION_LIMIT?.trim()) {
      process.env.AIRDROP_DB_CONNECTION_LIMIT = "4";
    }
    assertDatabaseConfigured(PROJECT_ROOT);
  } catch (e) {
    console.error("[wallets:generate] bootstrap failed:", e instanceof Error ? e.message : e);
    process.exit(1);
  }

  console.info("[wallets:generate] started — polling for pending or resumable batches (Ctrl+C to stop)");
  await walletGenerationPollLoop({ logPrefix: "[wallets:generate]", yieldMsAfterChunk: 0 });
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
