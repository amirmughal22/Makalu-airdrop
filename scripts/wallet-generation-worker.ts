/**
 * Background worker: fills `generated_wallets` for rows in `generated_wallet_batches` with status `pending`.
 *
 *   npm run wallets:generate
 *
 * Env: DATABASE_URL, AUTH_SECRET or AIRDROP_WALLET_STORAGE_SECRET, WALLET_GENERATION_BATCH_SIZE (optional).
 */
import { Wallet } from "ethers";
import { bootstrapProductionEnv, assertDatabaseConfigured } from "../src/lib/queue/production-env";
import { encryptWalletField } from "../src/lib/wallet-field-crypto";
import { walletGenerationInsertChunk } from "../src/lib/generated-wallet-config";
import {
  claimNextPendingBatch,
  insertGeneratedWalletChunk,
  markBatchCompleted,
  markBatchFailed,
} from "../src/lib/generated-wallet-repo";
import { getPostgresPool, pgExecute } from "../src/lib/postgres";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const PROJECT_ROOT = process.cwd();

void (async () => {
  try {
    bootstrapProductionEnv(PROJECT_ROOT);
    assertDatabaseConfigured(PROJECT_ROOT);
  } catch (e) {
    console.error("[wallets:generate] bootstrap failed:", e instanceof Error ? e.message : e);
    process.exit(1);
  }

  console.info("[wallets:generate] started — polling for pending batches (Ctrl+C to stop)");
  const chunk = walletGenerationInsertChunk();

  for (;;) {
    let batch: Awaited<ReturnType<typeof claimNextPendingBatch>> = null;
    try {
      batch = await claimNextPendingBatch();
    } catch (e) {
      console.error("[wallets:generate] claim failed", e);
      await sleep(3000);
      continue;
    }
    if (!batch) {
      await sleep(2000);
      continue;
    }

    const batchId = batch.id;
    const total = batch.total_wallets;
    console.info(`[wallets:generate] batch ${batchId} total=${total} name=${batch.name}`);

    try {
      let nextIndex = batch.inserted_wallets + 1;
      if (nextIndex < 1) nextIndex = 1;

      while (nextIndex <= total) {
        const rows: { wallet_index: number; address: string; private_key_encrypted: string }[] = [];
        const take = Math.min(chunk, total - nextIndex + 1);
        for (let i = 0; i < take; i++) {
          const w = Wallet.createRandom();
          const idx = nextIndex + i;
          rows.push({
            wallet_index: idx,
            address: w.address,
            private_key_encrypted: encryptWalletField(w.privateKey),
          });
        }

        const pool = await getPostgresPool();
        const conn = await pool.connect();
        try {
          await conn.query("BEGIN");
          await insertGeneratedWalletChunk(conn, batchId, rows);
          await pgExecute(
            conn,
            `UPDATE generated_wallet_batches SET inserted_wallets = inserted_wallets + ?, updated_at = NOW() WHERE id = ?::uuid`,
            [rows.length, batchId],
          );
          await conn.query("COMMIT");
        } catch (e) {
          await conn.query("ROLLBACK").catch(() => {});
          throw e;
        } finally {
          conn.release();
        }

        nextIndex += rows.length;
        if (nextIndex % (chunk * 10) === 1 || nextIndex > total) {
          console.info(`[wallets:generate] batch ${batchId} progress ${Math.min(nextIndex - 1, total)}/${total}`);
        }
      }

      await markBatchCompleted(batchId);
      console.info(`[wallets:generate] batch ${batchId} completed`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[wallets:generate] batch ${batchId} failed`, e);
      await markBatchFailed(batchId, msg);
    }
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
