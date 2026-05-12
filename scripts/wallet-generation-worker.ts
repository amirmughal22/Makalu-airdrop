/**
 * Background worker: fills `generated_wallets` for `generated_wallet_batches` that are `pending` or
 * **`running` with partial progress** (resume after crash, deploy restart, or Ctrl+C).
 *
 *   npm run wallets:generate
 *
 * Uses a PostgreSQL advisory lock per batch so two wallet workers never insert into the same batch concurrently.
 * Dashboard/API: `POST /api/airdrop/wallet-batches/{id}/resume` requeues `running` → `pending` if you prefer that path.
 *
 * Env: DATABASE_URL, WALLET_GENERATION_BATCH_SIZE (optional). If `AIRDROP_DB_CONNECTION_LIMIT` is unset, this script sets it to **4** after loading `.env` to reduce `max_connections` pressure.
 */
import { Wallet } from "ethers";
import { bootstrapProductionEnv, assertDatabaseConfigured } from "../src/lib/queue/production-env";
import { walletGenerationInsertChunk } from "../src/lib/generated-wallet-config";
import {
  claimNextPendingBatch,
  insertGeneratedWalletChunk,
  markBatchCompleted,
  markBatchFailed,
  type GeneratedBatchListRow,
} from "../src/lib/generated-wallet-repo";
import { getPostgresPool, pgExecute, pgQuery } from "../src/lib/postgres";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Namespace int for `pg_advisory_lock(classid, hashtext(batch_id))` — avoids collisions with other app locks. */
const WALLET_GEN_ADVISORY_CLASS = 8_420_001;

const PROJECT_ROOT = process.cwd();

void (async () => {
  try {
    bootstrapProductionEnv(PROJECT_ROOT);
    // One process should not open a large pool; wallet-gen holds one client for most work (see markBatch* on same client).
    if (!process.env.AIRDROP_DB_CONNECTION_LIMIT?.trim()) {
      process.env.AIRDROP_DB_CONNECTION_LIMIT = "4";
    }
    assertDatabaseConfigured(PROJECT_ROOT);
  } catch (e) {
    console.error("[wallets:generate] bootstrap failed:", e instanceof Error ? e.message : e);
    process.exit(1);
  }

  console.info("[wallets:generate] started — polling for pending or resumable batches (Ctrl+C to stop)");
  const chunk = walletGenerationInsertChunk();

  outer: for (;;) {
    let batch: Awaited<ReturnType<typeof claimNextPendingBatch>> = null;
    try {
      batch = await claimNextPendingBatch();
    } catch (e) {
      const code = e && typeof e === "object" && "code" in e ? String((e as { code: string }).code) : "";
      if (code === "53300") {
        console.error(
          "[wallets:generate] Postgres refused new connections (max_connections). Reduce AIRDROP_DB_CONNECTION_LIMIT on web/worker services or increase Postgres max_connections.",
        );
        await sleep(10_000);
      } else {
        console.error("[wallets:generate] claim failed", e);
        await sleep(3000);
      }
      continue;
    }
    if (!batch) {
      await sleep(2000);
      continue;
    }

    const batchId = batch.id;
    console.info(`[wallets:generate] batch ${batchId} total=${batch.total_wallets} name=${batch.name}`);

    const pool = await getPostgresPool();
    const client = await pool.connect();
    try {
      await client.query(`SELECT pg_advisory_lock($1::integer, hashtext($2::text))`, [WALLET_GEN_ADVISORY_CLASS, batchId]);
      try {
        const freshRows = await pgQuery<GeneratedBatchListRow>(
          client,
          `SELECT id::text AS id, owner, name, total_wallets, inserted_wallets, status,
                  created_at, updated_at, completed_at, error
           FROM generated_wallet_batches WHERE id = ?::uuid LIMIT 1`,
          [batchId],
        );
        const row = freshRows[0];
        if (!row || row.status === "completed" || row.inserted_wallets >= row.total_wallets) {
          console.info(`[wallets:generate] batch ${batchId} already finished after lock; skipping`);
          continue outer;
        }

        const total = row.total_wallets;
        let nextIndex = row.inserted_wallets + 1;
        if (nextIndex < 1) nextIndex = 1;

        while (nextIndex <= total) {
          const rows: { wallet_index: number; address: string; private_key_encrypted: null }[] = [];
          const take = Math.min(chunk, total - nextIndex + 1);
          for (let i = 0; i < take; i++) {
            const w = Wallet.createRandom();
            const idx = nextIndex + i;
            rows.push({
              wallet_index: idx,
              address: w.address,
              private_key_encrypted: null,
            });
          }

          try {
            await client.query("BEGIN");
            await insertGeneratedWalletChunk(client, batchId, rows);
            await pgExecute(
              client,
              `UPDATE generated_wallet_batches SET inserted_wallets = inserted_wallets + ?, updated_at = NOW() WHERE id = ?::uuid`,
              [rows.length, batchId],
            );
            await client.query("COMMIT");
          } catch (e) {
            await client.query("ROLLBACK").catch(() => {});
            throw e;
          }

          nextIndex += rows.length;
          if (nextIndex % (chunk * 10) === 1 || nextIndex > total) {
            console.info(`[wallets:generate] batch ${batchId} progress ${Math.min(nextIndex - 1, total)}/${total}`);
          }
        }

        await markBatchCompleted(batchId, client);
        console.info(`[wallets:generate] batch ${batchId} completed`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[wallets:generate] batch ${batchId} failed`, e);
        await markBatchFailed(batchId, msg, client);
      } finally {
        await client
          .query(`SELECT pg_advisory_unlock($1::integer, hashtext($2::text))`, [WALLET_GEN_ADVISORY_CLASS, batchId])
          .catch(() => {});
      }
    } finally {
      client.release();
    }
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
