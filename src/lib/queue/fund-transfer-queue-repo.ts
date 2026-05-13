import { randomUUID } from "node:crypto";
import { getPostgresPool, pgExecute, pgQuery } from "../postgres";
import { safeRollbackPgClient } from "../postgres-rollback";
import { getBatchForOwner } from "../generated-wallet-repo";
import {
  claimNotBlockedByProcessingFundTransfers,
  claimNotBlockedByProcessingJobWallets,
} from "./claim-select-sql";
import {
  isAirdropQueueV2Enabled,
  queueClaimBatchSize,
  queueGlobalPaused,
  queueMaxAttempts,
  queueRetryBackoffMsForRetryCount,
  queueStaleProcessingThresholdMs,
} from "./config";
import { getQueueRuntimeFlagsSync, refreshQueueRuntimeCache } from "./queue-runtime-settings";

const FUND_TRANSFER_INSERT_CHUNK = 5000;

export type ClaimedFundTransferRow = {
  id: number;
  fundTransferJobId: string;
  owner: string;
  signerAddress: string;
  targetWalletAddress: string;
  amount: string;
  mode: "native" | "erc20";
  tokenAddress: string | null;
  chainId: number;
  retryCount: number;
};

/** Reset stale `processing` fund transfer rows (worker crash). */
export async function reconcileStaleFundTransferProcessing(): Promise<number> {
  const pool = await getPostgresPool();
  const ms = queueStaleProcessingThresholdMs();
  const before = new Date(Date.now() - ms);
  const maxAttempts = queueMaxAttempts();
  const result = await pgExecute(
    pool,
    `UPDATE fund_transfer_queue
     SET status = 'pending',
         assigned_worker = NULL,
         next_attempt_at = NULL,
         error_message = LEFT(
           COALESCE(error_message, '') || ' | stale fund transfer reset (was worker ' || COALESCE(assigned_worker, CHR(63)) || ')',
           8000
         ),
         updated_at = NOW()
     WHERE status = 'processing'
       AND updated_at < ?
       AND retry_count < ?`,
    [before, maxAttempts],
  );
  return result.rowCount ?? 0;
}

export type CreateFundTransferFromBatchInput = {
  ownerLower: string;
  /** Optional label for dashboard lists. */
  name?: string | null;
  batchId: string;
  fromWalletIndex: number;
  toWalletIndex: number;
  amountPerWallet: string;
  signerAddress: string;
  mode: "native" | "erc20";
  tokenAddress?: string | null;
  chainId: number;
};

/**
 * Creates a `fund_transfer_jobs` row and enqueues one `fund_transfer_queue` row per generated wallet in range.
 * Uses chunked `INSERT … SELECT` (DB-side, no full-range load into app memory).
 */
export async function createFundTransferJobFromBatchRange(input: CreateFundTransferFromBatchInput): Promise<{
  jobId: string;
  rowsInserted: number;
}> {
  const batch = await getBatchForOwner(input.batchId, input.ownerLower);
  if (!batch) throw new Error("Batch not found or access denied");
  if (batch.status !== "completed") {
    throw new Error("Batch must be completed before queueing fund transfers to its wallets");
  }

  const from = Math.floor(input.fromWalletIndex);
  const to = Math.floor(input.toWalletIndex);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from < 1 || to < from) {
    throw new Error("Invalid wallet index range (from ≤ to, both ≥ 1)");
  }
  if (to > batch.inserted_wallets) {
    throw new Error(`to_wallet_index (${to}) exceeds batch inserted_wallets (${batch.inserted_wallets})`);
  }

  const amt = String(input.amountPerWallet || "").trim();
  if (!amt || Number(amt) <= 0) throw new Error("amountPerWallet must be positive");

  const signer = String(input.signerAddress || "").trim().toLowerCase();
  if (!signer.startsWith("0x") || signer.length < 42) throw new Error("Invalid signer address");

  const mode = input.mode === "native" ? "native" : "erc20";
  const token = mode === "erc20" ? String(input.tokenAddress || "").trim().toLowerCase() : null;
  if (mode === "erc20" && (!token || !token.startsWith("0x"))) throw new Error("tokenAddress required for ERC-20");

  const jobId = randomUUID().replace(/-/g, "");
  const name = input.name?.trim() || `Fund batch ${input.batchId.slice(0, 8)}… ${from}–${to}`;

  const pool = await getPostgresPool();
  const conn = await pool.connect();
  let inserted = 0;
  try {
    await conn.query("BEGIN");
    await pgExecute(
      conn,
      `INSERT INTO fund_transfer_jobs (
        id, owner, name, generated_batch_id, from_wallet_index, to_wallet_index,
        amount_per_wallet, signer_address, mode, token_address, chain_id, total_rows
      ) VALUES (?, ?, ?, ?::uuid, ?, ?, ?, ?, ?, ?, ?, 0)`,
      [
        jobId,
        input.ownerLower,
        name,
        input.batchId,
        from,
        to,
        amt,
        signer,
        mode,
        token,
        input.chainId,
      ],
    );

    for (let lo = from; lo <= to; lo += FUND_TRANSFER_INSERT_CHUNK) {
      const hi = Math.min(to, lo + FUND_TRANSFER_INSERT_CHUNK - 1);
      const r = await pgExecute(
        conn,
        `INSERT INTO fund_transfer_queue (
          fund_transfer_job_id, transfer_type, owner, generated_batch_id, wallet_index,
          signer_address, target_wallet_address, amount, mode, token_address, chain_id
        )
        SELECT ?,
               'airdrop_fund_transfer',
               b.owner,
               gw.batch_id,
               gw.wallet_index,
               ?,
               lower(trim(gw.address)),
               ?,
               ?,
               ?,
               ?
        FROM generated_wallets gw
        INNER JOIN generated_wallet_batches b ON b.id = gw.batch_id
        WHERE gw.batch_id = ?::uuid
          AND gw.wallet_index BETWEEN ? AND ?
          AND lower(b.owner) = lower(?)`,
        [
          jobId,
          signer,
          amt,
          mode,
          mode === "erc20" ? token : null,
          input.chainId,
          input.batchId,
          lo,
          hi,
          input.ownerLower,
        ],
      );
      inserted += r.rowCount ?? 0;
    }

    await pgExecute(conn, `UPDATE fund_transfer_jobs SET total_rows = ?, updated_at = NOW() WHERE id = ?`, [
      inserted,
      jobId,
    ]);
    await conn.query("COMMIT");
  } catch (e) {
    await safeRollbackPgClient(conn, `createFundTransferJobFromBatchRange:${e instanceof Error ? e.message : String(e)}`);
    throw e;
  } finally {
    conn.release();
  }

  return { jobId, rowsInserted: inserted };
}

export type FundTransferJobListRow = {
  id: string;
  name: string | null;
  generated_batch_id: string;
  from_wallet_index: number;
  to_wallet_index: number;
  amount_per_wallet: string;
  signer_address: string;
  mode: string;
  chain_id: number;
  total_rows: number;
  created_at: Date;
};

export async function listFundTransferJobsForOwner(
  ownerLower: string,
  limit: number,
  offset: number,
): Promise<FundTransferJobListRow[]> {
  const pool = await getPostgresPool();
  const rows = await pgQuery<FundTransferJobListRow>(
    pool,
    `SELECT id, name, generated_batch_id::text AS generated_batch_id, from_wallet_index, to_wallet_index,
            amount_per_wallet, signer_address, mode, chain_id, total_rows, created_at
     FROM fund_transfer_jobs
     WHERE lower(owner) = lower(?)
     ORDER BY created_at DESC
     LIMIT ? OFFSET ?`,
    [ownerLower, limit, offset],
  );
  return rows;
}

export async function countFundTransferJobsForOwner(ownerLower: string): Promise<number> {
  const pool = await getPostgresPool();
  const r = await pgQuery<{ c: string }>(
    pool,
    `SELECT COUNT(*)::text AS c FROM fund_transfer_jobs WHERE lower(owner) = lower(?)`,
    [ownerLower],
  );
  return Number(r[0]?.c ?? 0);
}

export type FundTransferJobStats = {
  jobId: string;
  total: number;
  pending: number;
  processing: number;
  completed: number;
  failed: number;
  txLast1m: number;
};

export async function getFundTransferJobStats(jobId: string, ownerLower: string): Promise<FundTransferJobStats | null> {
  const pool = await getPostgresPool();
  const job = await pgQuery<{ id: string }>(
    pool,
    `SELECT id FROM fund_transfer_jobs WHERE id = ? AND lower(owner) = lower(?)`,
    [jobId, ownerLower],
  );
  if (!job.length) return null;

  const rows = await pgQuery<Record<string, string>>(
    pool,
    `SELECT
       COUNT(*)::text AS total,
       COUNT(*) FILTER (WHERE status = 'pending')::text AS pending,
       COUNT(*) FILTER (WHERE status = 'processing')::text AS processing,
       COUNT(*) FILTER (WHERE status = 'completed')::text AS completed,
       COUNT(*) FILTER (WHERE status = 'failed')::text AS failed,
       COUNT(*) FILTER (WHERE status = 'completed' AND updated_at > NOW() - INTERVAL '1 minute')::text AS tx_last_1m
     FROM fund_transfer_queue
     WHERE fund_transfer_job_id = ?`,
    [jobId],
  );
  const s = rows[0]!;
  return {
    jobId,
    total: Number(s.total ?? 0),
    pending: Number(s.pending ?? 0),
    processing: Number(s.processing ?? 0),
    completed: Number(s.completed ?? 0),
    failed: Number(s.failed ?? 0),
    txLast1m: Number(s.tx_last_1m ?? 0),
  };
}

/** Move `failed` rows back to `pending` with cleared error (respect max attempts separately at claim time). */
export async function adminRetryFailedFundTransfers(jobId: string, ownerLower: string): Promise<number> {
  const pool = await getPostgresPool();
  const ok = await pgQuery<{ id: string }>(
    pool,
    `SELECT id FROM fund_transfer_jobs WHERE id = ? AND lower(owner) = lower(?)`,
    [jobId, ownerLower],
  );
  if (!ok.length) return 0;
  const r = await pgExecute(
    pool,
    `UPDATE fund_transfer_queue
     SET status = 'pending',
         retry_count = 0,
         error_message = NULL,
         next_attempt_at = NULL,
         assigned_worker = NULL,
         tx_hash = NULL,
         rpc_url = NULL,
         updated_at = NOW()
     WHERE fund_transfer_job_id = ? AND status = 'failed'`,
    [jobId],
  );
  return r.rowCount ?? 0;
}

export async function claimFundTransferBatch(workerId: string): Promise<ClaimedFundTransferRow[]> {
  await refreshQueueRuntimeCache();
  if (!isAirdropQueueV2Enabled() || queueGlobalPaused() || !getQueueRuntimeFlagsSync().processingEnabled) {
    return [];
  }
  const pool = await getPostgresPool();
  const batch = queueClaimBatchSize();
  const maxAttempts = queueMaxAttempts();

  const ftPickSub = `SELECT DISTINCT ON (lower(trim(ft.signer_address)))
       ft.id AS id, ft.fund_transfer_job_id AS "fundTransferJobId", ft.owner AS owner,
              ft.signer_address AS "signerAddress", ft.target_wallet_address AS "targetWalletAddress",
              ft.amount AS amount, ft.mode AS mode, ft.token_address AS "tokenAddress", ft.chain_id AS "chainId",
              ft.retry_count AS "retryCount"
       FROM fund_transfer_queue ft
       WHERE ft.status = 'pending'
         AND ft.transfer_type = 'airdrop_fund_transfer'
         AND (ft.next_attempt_at IS NULL OR ft.next_attempt_at <= NOW())
         AND ft.retry_count < ?
         AND ${claimNotBlockedByProcessingJobWallets(`lower(trim(ft.signer_address))`)}
         AND ${claimNotBlockedByProcessingFundTransfers(`lower(trim(ft.signer_address))`)}
         AND NOT EXISTS (
           SELECT 1 FROM fund_transfer_queue fty
           WHERE fty.status = 'processing'
             AND lower(trim(fty.signer_address)) = lower(trim(ft.signer_address))
         )
       ORDER BY lower(trim(ft.signer_address)),
                md5(ft.fund_transfer_job_id || ':' || ft.id::text),
                ft.fund_transfer_job_id,
                ft.id
       LIMIT ?`;
  const sql = `SELECT picked.id AS id, picked."fundTransferJobId" AS "fundTransferJobId", picked.owner AS owner,
       picked."signerAddress" AS "signerAddress", picked."targetWalletAddress" AS "targetWalletAddress",
       picked.amount AS amount, picked.mode AS mode, picked."tokenAddress" AS "tokenAddress",
       picked."chainId" AS "chainId", picked."retryCount" AS "retryCount"
       FROM (${ftPickSub}) picked
       INNER JOIN fund_transfer_queue ft ON ft.id = picked.id
       FOR UPDATE OF ft SKIP LOCKED`;

  const conn = await pool.connect();
  try {
    await conn.query("BEGIN");
    const rows = await pgQuery<Record<string, unknown>>(conn, sql, [maxAttempts, batch]);
    if (!rows.length) {
      await conn.query("COMMIT");
      return [];
    }
    const ids = rows.map((r) => Number(r.id));
    const ph = ids.map(() => "?").join(",");
    await pgExecute(
      conn,
      `UPDATE fund_transfer_queue ft
       SET status = 'processing',
           assigned_worker = ?,
           updated_at = NOW()
       WHERE ft.id IN (${ph})`,
      [workerId.slice(0, 64), ...ids],
    );
    await conn.query("COMMIT");
    return rows.map((r) => ({
      id: Number(r.id),
      fundTransferJobId: String(r.fundTransferJobId),
      owner: String(r.owner).toLowerCase(),
      signerAddress: String(r.signerAddress).toLowerCase(),
      targetWalletAddress: String(r.targetWalletAddress).toLowerCase(),
      amount: String(r.amount),
      mode: r.mode === "erc20" ? "erc20" : "native",
      tokenAddress: r.tokenAddress != null ? String(r.tokenAddress) : null,
      chainId: r.chainId != null ? Number(r.chainId) : 0,
      retryCount: Number(r.retryCount ?? 0),
    }));
  } catch (e) {
    await safeRollbackPgClient(conn, `claimFundTransferBatch:${e instanceof Error ? e.message : String(e)}`);
    throw e;
  } finally {
    conn.release();
  }
}

export async function recordFundTransferSuccess(
  rowId: number,
  txHash: string,
  rpcUrl: string,
): Promise<void> {
  const pool = await getPostgresPool();
  await pgExecute(
    pool,
    `UPDATE fund_transfer_queue
     SET status = 'completed', tx_hash = ?, rpc_url = ?, error_message = NULL,
         next_attempt_at = NULL, assigned_worker = NULL, updated_at = NOW()
     WHERE id = ?`,
    [txHash.slice(0, 128), rpcUrl.slice(0, 512), rowId],
  );
  await pgExecute(
    pool,
    `UPDATE fund_transfer_jobs j
     SET updated_at = NOW()
     WHERE EXISTS (SELECT 1 FROM fund_transfer_queue q WHERE q.id = ? AND q.fund_transfer_job_id = j.id)`,
    [rowId],
  );
}

export async function recordFundTransferFailure(
  rowId: number,
  errMsg: string,
  previousRetryCount: number,
): Promise<void> {
  const pool = await getPostgresPool();
  const maxAttempts = queueMaxAttempts();
  const nextRetry = previousRetryCount + 1;
  const terminal = nextRetry >= maxAttempts;
  if (terminal) {
    await pgExecute(
      pool,
      `UPDATE fund_transfer_queue
       SET status = 'failed',
          retry_count = ?,
          error_message = ?,
          assigned_worker = NULL,
          next_attempt_at = NULL,
          updated_at = NOW()
       WHERE id = ?`,
      [nextRetry, errMsg.slice(0, 8000), rowId],
    );
  } else {
    const backoffMs = queueRetryBackoffMsForRetryCount(nextRetry);
    const nextAt = new Date(Date.now() + backoffMs);
    await pgExecute(
      pool,
      `UPDATE fund_transfer_queue
       SET status = 'pending',
           retry_count = ?,
           error_message = ?,
           assigned_worker = NULL,
           next_attempt_at = ?,
           updated_at = NOW()
       WHERE id = ?`,
      [nextRetry, errMsg.slice(0, 8000), nextAt, rowId],
    );
  }
}
