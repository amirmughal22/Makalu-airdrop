import type { Pool, PoolClient } from "pg";
import { getPostgresPool, pgExecute, pgQuery } from "./postgres";

export type GeneratedBatchListRow = {
  id: string;
  owner: string;
  name: string;
  total_wallets: number;
  inserted_wallets: number;
  status: string;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
  error: string | null;
};

export async function insertPendingBatch(ownerLower: string, name: string, totalWallets: number): Promise<string> {
  const pool = await getPostgresPool();
  const rows = await pgQuery<{ id: string }>(
    pool,
    `INSERT INTO generated_wallet_batches (owner, name, total_wallets, inserted_wallets, status)
     VALUES (?, ?, ?, 0, 'pending')
     RETURNING id::text AS id`,
    [ownerLower, name.trim().slice(0, 500), totalWallets],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error("Failed to create wallet batch");
  return id;
}

export async function listBatchesForOwner(
  ownerLower: string,
  limit: number,
  offset: number,
): Promise<GeneratedBatchListRow[]> {
  const pool = await getPostgresPool();
  return pgQuery<GeneratedBatchListRow>(
    pool,
    `SELECT id::text AS id, owner, name, total_wallets, inserted_wallets, status,
            created_at, updated_at, completed_at, error
     FROM generated_wallet_batches
     WHERE owner = ?
     ORDER BY created_at DESC
     LIMIT ? OFFSET ?`,
    [ownerLower, limit, offset],
  );
}

export async function countBatchesForOwner(ownerLower: string): Promise<number> {
  const pool = await getPostgresPool();
  const r = await pgQuery<{ c: string }>(
    pool,
    `SELECT COUNT(*)::text AS c FROM generated_wallet_batches WHERE owner = ?`,
    [ownerLower],
  );
  return Number(r[0]?.c ?? 0);
}

export async function getBatchForOwner(
  batchId: string,
  ownerLower: string,
): Promise<GeneratedBatchListRow | undefined> {
  const pool = await getPostgresPool();
  const rows = await pgQuery<GeneratedBatchListRow>(
    pool,
    `SELECT id::text AS id, owner, name, total_wallets, inserted_wallets, status,
            created_at, updated_at, completed_at, error
     FROM generated_wallet_batches WHERE id = ?::uuid AND owner = ? LIMIT 1`,
    [batchId, ownerLower],
  );
  return rows[0];
}

/** Worker: claim one pending batch (SKIP LOCKED). Returns null if none. */
export async function claimNextPendingBatch(): Promise<GeneratedBatchListRow | null> {
  const pool = await getPostgresPool();
  const rows = await pgQuery<GeneratedBatchListRow>(
    pool,
    `UPDATE generated_wallet_batches b
     SET status = 'running', updated_at = NOW()
     WHERE b.id = (
       SELECT id FROM generated_wallet_batches
       WHERE status = 'pending'
       ORDER BY created_at ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING b.id::text AS id, b.owner, b.name, b.total_wallets, b.inserted_wallets, b.status,
               b.created_at, b.updated_at, b.completed_at, b.error`,
  );
  return rows[0] ?? null;
}

export async function bumpBatchInserted(batchId: string, delta: number): Promise<void> {
  const pool = await getPostgresPool();
  await pgExecute(
    pool,
    `UPDATE generated_wallet_batches
     SET inserted_wallets = inserted_wallets + ?, updated_at = NOW()
     WHERE id = ?::uuid`,
    [delta, batchId],
  );
}

export async function markBatchCompleted(batchId: string): Promise<void> {
  const pool = await getPostgresPool();
  await pgExecute(
    pool,
    `UPDATE generated_wallet_batches
     SET status = 'completed', completed_at = NOW(), updated_at = NOW()
     WHERE id = ?::uuid`,
    [batchId],
  );
}

export async function markBatchFailed(batchId: string, err: string): Promise<void> {
  const pool = await getPostgresPool();
  await pgExecute(
    pool,
    `UPDATE generated_wallet_batches
     SET status = 'failed', error = ?, updated_at = NOW(), completed_at = NOW()
     WHERE id = ?::uuid`,
    [err.slice(0, 8000), batchId],
  );
}

export type GeneratedWalletInsertRow = {
  wallet_index: number;
  address: string;
  private_key_encrypted: string;
};

export async function insertGeneratedWalletChunk(
  executor: Pick<Pool | PoolClient, "query">,
  batchId: string,
  rows: GeneratedWalletInsertRow[],
): Promise<void> {
  if (!rows.length) return;
  const placeholders = rows.map(() => "(?::uuid, ?, ?, ?)").join(", ");
  const flat: unknown[] = [];
  for (const r of rows) {
    flat.push(batchId, r.wallet_index, r.address.toLowerCase(), r.private_key_encrypted);
  }
  await pgExecute(
    executor,
    `INSERT INTO generated_wallets (batch_id, wallet_index, address, private_key_encrypted) VALUES ${placeholders}`,
    flat,
  );
}

export type WalletPageRow = {
  id: string;
  wallet_index: number;
  address: string;
  created_at: Date;
};

export async function listGeneratedWalletsPage(params: {
  batchId: string;
  ownerLower: string;
  limit: number;
  offset: number;
  search?: string;
}): Promise<WalletPageRow[]> {
  const pool = await getPostgresPool();
  const search = params.search?.trim().toLowerCase();
  if (search) {
    return pgQuery<WalletPageRow>(
      pool,
      `SELECT gw.id::text AS id, gw.wallet_index, gw.address, gw.created_at
       FROM generated_wallets gw
       INNER JOIN generated_wallet_batches b ON b.id = gw.batch_id
       WHERE gw.batch_id = ?::uuid AND b.owner = ? AND lower(gw.address) LIKE ?
       ORDER BY gw.wallet_index ASC
       LIMIT ? OFFSET ?`,
      [params.batchId, params.ownerLower, `%${search.replace(/%/g, "")}%`, params.limit, params.offset],
    );
  }
  return pgQuery<WalletPageRow>(
    pool,
    `SELECT gw.id::text AS id, gw.wallet_index, gw.address, gw.created_at
     FROM generated_wallets gw
     INNER JOIN generated_wallet_batches b ON b.id = gw.batch_id
     WHERE gw.batch_id = ?::uuid AND b.owner = ?
     ORDER BY gw.wallet_index ASC
     LIMIT ? OFFSET ?`,
    [params.batchId, params.ownerLower, params.limit, params.offset],
  );
}

export async function countGeneratedWalletsPage(params: {
  batchId: string;
  ownerLower: string;
  search?: string;
}): Promise<number> {
  const pool = await getPostgresPool();
  const search = params.search?.trim().toLowerCase();
  if (search) {
    const r = await pgQuery<{ c: string }>(
      pool,
      `SELECT COUNT(*)::text AS c
       FROM generated_wallets gw
       INNER JOIN generated_wallet_batches b ON b.id = gw.batch_id
       WHERE gw.batch_id = ?::uuid AND b.owner = ? AND lower(gw.address) LIKE ?`,
      [params.batchId, params.ownerLower, `%${search.replace(/%/g, "")}%`],
    );
    return Number(r[0]?.c ?? 0);
  }
  const r = await pgQuery<{ c: string }>(
    pool,
    `SELECT COUNT(*)::text AS c
     FROM generated_wallets gw
     INNER JOIN generated_wallet_batches b ON b.id = gw.batch_id
     WHERE gw.batch_id = ?::uuid AND b.owner = ?`,
    [params.batchId, params.ownerLower],
  );
  return Number(r[0]?.c ?? 0);
}

export async function exportGeneratedWalletsWithKeys(params: {
  batchId: string;
  ownerLower: string;
  limit: number;
  offset: number;
}): Promise<Array<{ wallet_index: number; address: string; private_key_encrypted: string }>> {
  const pool = await getPostgresPool();
  return pgQuery(
    pool,
    `SELECT gw.wallet_index, gw.address, gw.private_key_encrypted
     FROM generated_wallets gw
     INNER JOIN generated_wallet_batches b ON b.id = gw.batch_id
     WHERE gw.batch_id = ?::uuid AND b.owner = ?
     ORDER BY gw.wallet_index ASC
     LIMIT ? OFFSET ?`,
    [params.batchId, params.ownerLower, params.limit, params.offset],
  );
}
