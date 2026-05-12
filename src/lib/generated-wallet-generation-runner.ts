/**
 * Polls `generated_wallet_batches` and fills `generated_wallets` — shared by
 * `npm run wallets:generate` and the optional in-process embedded loop.
 */
import { Wallet } from "ethers";
import { walletGenerationInsertChunk } from "./generated-wallet-config";
import {
  claimNextPendingBatch,
  insertGeneratedWalletChunk,
  markBatchCompleted,
  markBatchFailed,
  type GeneratedBatchListRow,
} from "./generated-wallet-repo";
import { getPostgresPool, pgExecute, pgQuery } from "./postgres";

const WALLET_GEN_ADVISORY_CLASS = 8_420_001;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export type WalletGenerationPollOptions = {
  logPrefix: string;
  /** Sleep after each committed chunk so HTTP handlers get CPU (embedded mode). 0 = off. */
  yieldMsAfterChunk?: number;
};

/**
 * Infinite loop: claim pending / resumable batches, insert address chunks, complete or fail.
 * Stops only on process exit. Safe alongside a standalone `wallets:generate` (advisory lock per batch).
 */
export async function walletGenerationPollLoop(opts: WalletGenerationPollOptions): Promise<void> {
  const chunk = walletGenerationInsertChunk();
  const yieldMs = Math.max(0, opts.yieldMsAfterChunk ?? 0);

  outer: for (;;) {
    let batch: Awaited<ReturnType<typeof claimNextPendingBatch>> = null;
    try {
      batch = await claimNextPendingBatch();
    } catch (e) {
      const code = e && typeof e === "object" && "code" in e ? String((e as { code: string }).code) : "";
      if (code === "53300") {
        console.error(
          `${opts.logPrefix} Postgres refused new connections (max_connections). Reduce AIRDROP_DB_CONNECTION_LIMIT or raise max_connections.`,
        );
        await sleep(10_000);
      } else {
        console.error(`${opts.logPrefix} claim failed`, e);
        await sleep(3000);
      }
      continue;
    }
    if (!batch) {
      await sleep(2000);
      continue;
    }

    const batchId = batch.id;
    console.info(`${opts.logPrefix} batch ${batchId} total=${batch.total_wallets} name=${batch.name}`);

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
          console.info(`${opts.logPrefix} batch ${batchId} already finished after lock; skipping`);
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
            console.info(`${opts.logPrefix} batch ${batchId} progress ${Math.min(nextIndex - 1, total)}/${total}`);
          }
          if (yieldMs > 0) await sleep(yieldMs);
        }

        await markBatchCompleted(batchId, client);
        console.info(`${opts.logPrefix} batch ${batchId} completed`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`${opts.logPrefix} batch ${batchId} failed`, e);
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
}
