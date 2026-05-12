import type { RowDataPacket } from "mysql2";
import type { ResultSetHeader } from "mysql2";
import type { PoolConnection } from "mysql2/promise";
import { getMysqlPool } from "../mysql";
import { MAX_JOB_TARGET_RUNS } from "../job-types";
import type { RecipientInput } from "../job-types";
import {
  collectQueueClaimBlockers,
  isAirdropQueueV2Enabled,
  queueBulkInsertChunk,
  queueClaimBatchSize,
  queueGlobalPaused,
  queueMaxAttempts,
  queueRetryBackoffMsForRetryCount,
  queueStaleProcessingMs,
} from "./config";
import { markWalletCompleted } from "./queue-worker-liveness";
import { recordClaimAttempt } from "./claim-attempt-stats";
import {
  CLAIM_SELECT_DIAG_SQL,
  isRuntimeQueueDiagEnabled,
  isSqlExplainEnabled,
  poolDiagnostics,
  sessionIsolation,
} from "./runtime-queue-diag";
import { getQueueRuntimeFlagsSync, refreshQueueRuntimeCache } from "./queue-runtime-settings";
import type { ClaimedWalletRow, NormalizedJobRow } from "./types";

/** Drive job.status from wallet states — no COUNT(*) on job_wallets (hot path). */
const REFRESH_JOB_STATUS_SQL = `UPDATE jobs j
     SET
       status = CASE
         WHEN j.paused = 1 THEN j.status
         WHEN j.status IN ('draft', 'cancelled') THEN j.status
         WHEN EXISTS (
           SELECT 1 FROM job_wallets jw
           WHERE jw.job_id = j.id AND jw.status IN ('pending', 'processing')
         ) THEN CASE WHEN j.status = 'draft' THEN j.status ELSE 'running' END
         WHEN EXISTS (SELECT 1 FROM job_wallets jw WHERE jw.job_id = j.id AND jw.status = 'failed') THEN 'failed'
         ELSE 'completed'
       END,
       updated_at = CURRENT_TIMESTAMP(3)
     WHERE j.id = ?`;

async function refreshJobStatusOnlyConn(conn: PoolConnection, jobId: string): Promise<void> {
  await conn.execute(REFRESH_JOB_STATUS_SQL, [jobId]);
}

function isMysqlDeadlock(e: unknown): boolean {
  const x = e as { errno?: number; code?: string };
  return x.errno === 1213 || x.code === "ER_LOCK_DEADLOCK";
}

async function sleepMs(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/** InnoDB deadlocks when parallel txs touch the same `jobs` row — retry whole tx (MySQL recommendation). */
const WALLET_TX_DEADLOCK_RETRIES = 8;

function parseSignerAddressesJson(raw: unknown): string[] | null {
  if (raw == null) return null;
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (Array.isArray(parsed)) {
      const xs = parsed.filter((x): x is string => typeof x === "string").map((x) => x.toLowerCase());
      return xs.length ? xs : null;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function rowToNormalizedJob(row: RowDataPacket): NormalizedJobRow {
  const signers = parseSignerAddressesJson(row.signer_addresses_json);
  return {
    id: String(row.id),
    owner: String(row.owner).toLowerCase(),
    name: row.name != null ? String(row.name) : null,
    status: String(row.status),
    totalWallets: Number(row.total_wallets ?? 0),
    processedWallets: Number(row.processed_wallets ?? 0),
    failedWallets: Number(row.failed_wallets ?? 0),
    mode: row.mode === "erc20" ? "erc20" : "native",
    tokenAddress: row.token_address != null ? String(row.token_address) : null,
    chainId: row.chain_id != null && Number(row.chain_id) > 0 ? Number(row.chain_id) : null,
    paused: Boolean(row.paused),
    scheduledAt: row.scheduled_at ? new Date(row.scheduled_at).toISOString() : null,
    queuedAt: row.queued_at ? new Date(row.queued_at).toISOString() : null,
    targetRunCount: row.target_run_count != null ? Number(row.target_run_count) : 1,
    currentRun: row.current_run != null ? Number(row.current_run) : 1,
    loopForever: Boolean(row.loop_forever),
    signerAddress: row.signer_address != null ? String(row.signer_address) : null,
    signerAddresses: signers,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export async function getNormalizedJob(jobId: string): Promise<NormalizedJobRow | undefined> {
  const pool = await getMysqlPool();
  const [rows] = await pool.execute<RowDataPacket[]>("SELECT * FROM jobs WHERE id = ?", [jobId]);
  const row = rows[0];
  if (!row) return undefined;
  return rowToNormalizedJob(row);
}

export type CreateNormalizedJobInput = {
  jobId: string;
  ownerLower: string;
  name?: string | null;
  mode: "native" | "erc20";
  tokenAddress?: string | null;
  chainId: number;
  signerAddresses: string[];
  recipients: RecipientInput[];
  /** Wallet-row expansion passes (always 1 when using UI loop checkbox). */
  targetRunCount: number;
  /** When true, job is automatically re-queued after each completed/failed cycle until paused or cancelled. */
  loopForever?: boolean;
};

function expandRecipientsForRuns(
  recipients: RecipientInput[],
  signerAddresses: string[],
  targetRunCount: number,
): { expanded: Array<{ address: string; amount: string; signer: string }>; distributors: string[] } {
  const rawT = Math.floor(Number(targetRunCount ?? 1));
  const target =
    Number.isFinite(rawT) && rawT >= 1 ? Math.min(MAX_JOB_TARGET_RUNS, rawT) : 1;
  const distributors = [...new Set(signerAddresses.map((a) => a.toLowerCase()))];
  if (distributors.length === 0) throw new Error("No distributor wallets");

  const expanded: Array<{ address: string; amount: string; signer: string }> = [];
  let rowIndex = 0;
  for (let run = 0; run < target; run++) {
    for (const r of recipients) {
      const signer = distributors[rowIndex % distributors.length]!;
      expanded.push({
        address: r.address,
        amount: String(r.amount),
        signer,
      });
      rowIndex++;
    }
  }
  return { expanded, distributors };
}

/** Insert job + wallet rows (expanded by targetRunCount). Uses chunked bulk INSERT. */
export async function createNormalizedJob(input: CreateNormalizedJobInput): Promise<void> {
  const pool = await getMysqlPool();
  const chunkSize = queueBulkInsertChunk();
  const { expanded, distributors } = expandRecipientsForRuns(
    input.recipients,
    input.signerAddresses,
    input.targetRunCount,
  );
  const rawT = Math.floor(Number(input.targetRunCount ?? 1));
  const targetRuns =
    Number.isFinite(rawT) && rawT >= 1 ? Math.min(MAX_JOB_TARGET_RUNS, rawT) : 1;

  const signersJson = JSON.stringify(distributors);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.execute(
      `INSERT INTO jobs (
        id, owner, name, status, total_wallets, processed_wallets, failed_wallets,
        mode, token_address, chain_id, paused, scheduled_at, queued_at,
        target_run_count, current_run, loop_forever, signer_address, signer_addresses_json
      ) VALUES (?, ?, ?, 'draft', ?, 0, 0, ?, ?, ?, 0, NULL, NULL, ?, 1, ?, ?, ?)`,
      [
        input.jobId,
        input.ownerLower,
        input.name?.trim() || null,
        expanded.length,
        input.mode,
        input.mode === "erc20" ? input.tokenAddress ?? null : null,
        input.chainId,
        targetRuns,
        input.loopForever ? 1 : 0,
        distributors[0] ?? null,
        signersJson,
      ],
    );

    for (let i = 0; i < expanded.length; i += chunkSize) {
      const slice = expanded.slice(i, i + chunkSize);
      const placeholders = slice.map(() => "(?, ?, ?, 'pending', ?)").join(", ");
      const flat: string[] = [];
      for (const row of slice) {
        flat.push(input.jobId, row.address, row.amount, row.signer);
      }
      await conn.execute(
        `INSERT INTO job_wallets (job_id, wallet_address, amount, status, signer_address) VALUES ${placeholders}`,
        flat,
      );
    }

    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

export type ReplaceNormalizedDraftInput = {
  jobId: string;
  ownerLower: string;
  name?: string | null;
  mode: "native" | "erc20";
  tokenAddress?: string | null;
  chainId: number;
  signerAddresses: string[];
  recipients: RecipientInput[];
  targetRunCount: number;
};

/** Replace all `job_wallets` rows for a draft job (same expansion rules as create). */
export async function replaceNormalizedDraftJobWallets(input: ReplaceNormalizedDraftInput): Promise<void> {
  const pool = await getMysqlPool();
  const chunkSize = queueBulkInsertChunk();
  const { expanded, distributors } = expandRecipientsForRuns(
    input.recipients,
    input.signerAddresses,
    input.targetRunCount,
  );
  const rawT = Math.floor(Number(input.targetRunCount ?? 1));
  const target =
    Number.isFinite(rawT) && rawT >= 1 ? Math.min(MAX_JOB_TARGET_RUNS, rawT) : 1;
  const signersJson = JSON.stringify(distributors);

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [check] = await conn.execute<RowDataPacket[]>(
      `SELECT id, status, owner FROM jobs WHERE id = ? LIMIT 1 FOR UPDATE`,
      [input.jobId],
    );
    const row = check[0];
    if (!row) throw new Error("Job not found");
    if (String(row.owner).toLowerCase() !== input.ownerLower) throw new Error("Forbidden");
    if (String(row.status) !== "draft") throw new Error("Only draft jobs can edit recipients");

    await conn.execute(`DELETE FROM job_wallets WHERE job_id = ?`, [input.jobId]);

    await conn.execute(
      `UPDATE jobs SET
        name = COALESCE(?, name),
        mode = ?,
        token_address = ?,
        chain_id = ?,
        signer_address = ?,
        signer_addresses_json = ?,
        target_run_count = ?,
        total_wallets = ?,
        processed_wallets = 0,
        failed_wallets = 0,
        updated_at = CURRENT_TIMESTAMP(3)
       WHERE id = ?`,
      [
        input.name !== undefined ? input.name?.trim() || null : null,
        input.mode,
        input.mode === "erc20" ? input.tokenAddress ?? null : null,
        input.chainId,
        distributors[0] ?? null,
        signersJson,
        target,
        expanded.length,
        input.jobId,
      ],
    );

    for (let i = 0; i < expanded.length; i += chunkSize) {
      const slice = expanded.slice(i, i + chunkSize);
      const placeholders = slice.map(() => "(?, ?, ?, 'pending', ?)").join(", ");
      const flat: string[] = [];
      for (const row of slice) {
        flat.push(input.jobId, row.address, row.amount, row.signer);
      }
      await conn.execute(
        `INSERT INTO job_wallets (job_id, wallet_address, amount, status, signer_address) VALUES ${placeholders}`,
        flat,
      );
    }

    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
  await refreshJobAggregates(input.jobId);
}

export async function startNormalizedJob(jobId: string, ownerLower: string): Promise<boolean> {
  const pool = await getMysqlPool();
  const [result] = await pool.execute<ResultSetHeader>(
    `UPDATE jobs
     SET status = 'queued', queued_at = CURRENT_TIMESTAMP(3), paused = 0, updated_at = CURRENT_TIMESTAMP(3)
     WHERE id = ? AND owner = ? AND status = 'draft'`,
    [jobId, ownerLower],
  );
  return result.affectedRows === 1;
}

export async function claimWalletBatch(workerId: string): Promise<ClaimedWalletRow[]> {
  const diag = isRuntimeQueueDiagEnabled();
  const tStart = diag ? performance.now() : 0;
  /** Must run before sync flag checks — otherwise `isAirdropQueueV2Enabled()` can read stale cache forever. */
  await refreshQueueRuntimeCache();
  if (!isAirdropQueueV2Enabled()) {
    if (diag) {
      const b = collectQueueClaimBlockers();
      console.warn("[claim-diag] early_exit !queueV2 blockers=", b.join("; ") || "(none)");
      recordClaimAttempt({
        at: new Date().toISOString(),
        workerId,
        claimMs: Math.round(performance.now() - tStart),
        rowsReturned: 0,
        blockers: b.length ? b : ["normalized_queue_v2 or AIRDROP_QUEUE_V2 gate"],
      });
    }
    return [];
  }
  if (queueGlobalPaused()) {
    if (diag) console.warn("[claim-diag] early_exit AIRDROP_QUEUE_GLOBAL_PAUSED");
    return [];
  }
  if (!getQueueRuntimeFlagsSync().processingEnabled) {
    if (diag) console.warn("[claim-diag] early_exit processing_enabled=false");
    return [];
  }
  const pool = await getMysqlPool();
  const batch = queueClaimBatchSize();
  const maxAttempts = queueMaxAttempts();

  let pendingApprox = 0;
  let pendingStrictApprox = 0;
  let queuedJobsApprox = 0;
  if (diag) {
    try {
      const [ps] = await pool.execute<RowDataPacket[]>(
        `SELECT COUNT(*) AS c FROM job_wallets WHERE status = 'pending'`,
      );
      pendingStrictApprox = Number((ps[0] as { c: number }).c ?? 0);
      const [pr] = await pool.execute<RowDataPacket[]>(
        `SELECT COUNT(*) AS c FROM job_wallets WHERE status IN ('pending','processing')`,
      );
      pendingApprox = Number((pr[0] as { c: number }).c ?? 0);
      const [qj] = await pool.execute<RowDataPacket[]>(
        `SELECT COUNT(*) AS c FROM jobs WHERE status IN ('queued','running')`,
      );
      queuedJobsApprox = Number((qj[0] as { c: number }).c ?? 0);
      const flags = getQueueRuntimeFlagsSync();
      console.info(
        `[claim-diag] flags processing=${flags.processingEnabled} normalized_queue_v2=${flags.normalizedQueueV2} AIRDROP_QUEUE_V2=${process.env.AIRDROP_QUEUE_V2} globalPaused=${queueGlobalPaused()} pendingStrict~=${pendingStrictApprox} pendingOrProcessing~=${pendingApprox} queuedJobs~=${queuedJobsApprox}`,
      );
      console.info(`[claim-diag] pool ${JSON.stringify(poolDiagnostics(pool))}`);
      if (isSqlExplainEnabled()) {
        try {
          const [expl] = await pool.execute<RowDataPacket[]>(`EXPLAIN ${CLAIM_SELECT_DIAG_SQL}`, [
            maxAttempts,
            batch,
          ]);
          console.info("[claim-diag] EXPLAIN", JSON.stringify(expl));
        } catch (e) {
          console.warn("[claim-diag] EXPLAIN failed", e);
        }
      }
    } catch (e) {
      console.warn("[claim-diag] aggregate counts failed", e);
    }
  }

  const conn = await pool.getConnection();
  const txT0 = diag ? performance.now() : 0;
  try {
    await conn.beginTransaction();
    if (diag) {
      const iso = await sessionIsolation(conn);
      console.info(`[claim-diag] tx_begin_ms=${Math.round(performance.now() - txT0)} isolation=${iso ?? "?"}`);
    }
    const sql = `SELECT jw.id AS id, jw.job_id AS jobId, jw.wallet_address AS walletAddress, jw.amount AS amount,
              jw.retry_count AS retryCount, jw.signer_address AS signerAddress,
              j.owner AS owner, j.mode AS mode, j.token_address AS tokenAddress, j.chain_id AS chainId
       FROM job_wallets jw
       INNER JOIN jobs j ON j.id = jw.job_id
       WHERE jw.status = 'pending'
         AND (jw.next_attempt_at IS NULL OR jw.next_attempt_at <= CURRENT_TIMESTAMP(3))
         AND jw.retry_count < ?
         AND j.status IN ('queued', 'running')
         AND j.paused = 0
       ORDER BY jw.job_id, jw.id
       LIMIT ?
       FOR UPDATE SKIP LOCKED`;
    if (diag) console.info("[claim-diag] claim_sql=", sql.replace(/\s+/g, " ").slice(0, 220) + "…");

    const selT0 = performance.now();
    const [rows] = await conn.execute<RowDataPacket[]>(sql, [maxAttempts, batch]);
    const selMs = Math.round(performance.now() - selT0);

    if (!rows.length) {
      await conn.commit();
      const claimMs = Math.round(performance.now() - tStart);
      if (diag) {
        const blockers = collectQueueClaimBlockers();
        console.warn(
          `[claim-diag] rows=0 select_ms=${selMs} tx_total_ms=${Math.round(performance.now() - txT0)} blockers=${blockers.join(" | ") || "none — check job paused/draft, next_attempt_at, retry cap, or no pending rows"}`,
        );
        recordClaimAttempt({
          at: new Date().toISOString(),
          workerId,
          claimMs,
          rowsReturned: 0,
          pendingWalletApprox: pendingApprox,
          queuedJobsApprox,
          blockers: blockers.length ? blockers : undefined,
        });
      }
      return [];
    }

    const ids = rows.map((r) => Number(r.id));
    const ph = ids.map(() => "?").join(",");
    const updT0 = performance.now();
    await conn.execute(
      `UPDATE job_wallets SET status = 'processing', assigned_worker = ?, updated_at = CURRENT_TIMESTAMP(3) WHERE id IN (${ph})`,
      [workerId.slice(0, 64), ...ids],
    );
    if (diag) console.info(`[claim-diag] update_processing_ms=${Math.round(performance.now() - updT0)} ids=${ids.length}`);

    const jobIds = [...new Set(rows.map((r) => String(r.jobId)))];
    for (const jid of jobIds) {
      await conn.execute(
        `UPDATE jobs SET status = 'running', updated_at = CURRENT_TIMESTAMP(3) WHERE id = ? AND status = 'queued'`,
        [jid],
      );
    }

    const commitT0 = performance.now();
    await conn.commit();
    if (diag) {
      console.info(
        `[claim-diag] commit_ms=${Math.round(performance.now() - commitT0)} total_claim_ms=${Math.round(performance.now() - tStart)} rows=${rows.length}`,
      );
      recordClaimAttempt({
        at: new Date().toISOString(),
        workerId,
        claimMs: Math.round(performance.now() - tStart),
        rowsReturned: rows.length,
        pendingWalletApprox: pendingApprox,
        queuedJobsApprox,
      });
    }

    return rows.map((r) => ({
      id: Number(r.id),
      jobId: String(r.jobId),
      walletAddress: String(r.walletAddress),
      amount: String(r.amount),
      retryCount: Number(r.retryCount ?? 0),
      signerAddress: r.signerAddress ? String(r.signerAddress).toLowerCase() : null,
      owner: String(r.owner).toLowerCase(),
      mode: r.mode === "erc20" ? "erc20" : "native",
      tokenAddress: r.tokenAddress ? String(r.tokenAddress) : null,
      chainId: r.chainId != null ? Number(r.chainId) : null,
    }));
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

/**
 * Same claim path as {@link claimWalletBatch} but **rolls back** the transaction so rows stay `pending`.
 * For `npm run queue:test` — verifies SKIP LOCKED + locks without mutating queue state.
 */
export async function claimWalletBatchDryRun(workerId: string): Promise<number[]> {
  await refreshQueueRuntimeCache();
  if (!isAirdropQueueV2Enabled() || queueGlobalPaused() || !getQueueRuntimeFlagsSync().processingEnabled) {
    return [];
  }
  const pool = await getMysqlPool();
  const batch = queueClaimBatchSize();
  const maxAttempts = queueMaxAttempts();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const sql = `SELECT jw.id AS id, jw.job_id AS jobId, jw.wallet_address AS walletAddress, jw.amount AS amount,
              jw.retry_count AS retryCount, jw.signer_address AS signerAddress,
              j.owner AS owner, j.mode AS mode, j.token_address AS tokenAddress, j.chain_id AS chainId
       FROM job_wallets jw
       INNER JOIN jobs j ON j.id = jw.job_id
       WHERE jw.status = 'pending'
         AND (jw.next_attempt_at IS NULL OR jw.next_attempt_at <= CURRENT_TIMESTAMP(3))
         AND jw.retry_count < ?
         AND j.status IN ('queued', 'running')
         AND j.paused = 0
       ORDER BY jw.job_id, jw.id
       LIMIT ?
       FOR UPDATE SKIP LOCKED`;
    const [rows] = await conn.execute<RowDataPacket[]>(sql, [maxAttempts, batch]);
    if (!rows.length) {
      await conn.rollback();
      return [];
    }
    const ids = rows.map((r) => Number(r.id));
    const ph = ids.map(() => "?").join(",");
    await conn.execute(
      `UPDATE job_wallets SET status = 'processing', assigned_worker = ?, updated_at = CURRENT_TIMESTAMP(3) WHERE id IN (${ph})`,
      [workerId.slice(0, 64), ...ids],
    );
    const jobIds = [...new Set(rows.map((r) => String(r.jobId)))];
    for (const jid of jobIds) {
      await conn.execute(
        `UPDATE jobs SET status = 'running', updated_at = CURRENT_TIMESTAMP(3) WHERE id = ? AND status = 'queued'`,
        [jid],
      );
    }
    await conn.rollback();
    return ids;
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

/**
 * Full recount from `job_wallets` — O(n) per job. Use after bulk edits, migration, or admin repair.
 * Hot path (`recordWallet*`) uses incremental counters + {@link refreshJobStatusOnlyConn} only.
 */
export async function refreshJobAggregates(jobId: string): Promise<void> {
  const pool = await getMysqlPool();
  await pool.execute(
    `UPDATE jobs j
     SET
       processed_wallets = (SELECT COUNT(*) FROM job_wallets jw WHERE jw.job_id = j.id AND jw.status = 'completed'),
       failed_wallets = (SELECT COUNT(*) FROM job_wallets jw WHERE jw.job_id = j.id AND jw.status = 'failed'),
       total_wallets = (SELECT COUNT(*) FROM job_wallets jw WHERE jw.job_id = j.id),
       status = CASE
         WHEN j.paused = 1 THEN j.status
         WHEN j.status IN ('draft', 'cancelled') THEN j.status
         WHEN EXISTS (
           SELECT 1 FROM job_wallets jw
           WHERE jw.job_id = j.id AND jw.status IN ('pending', 'processing')
         ) THEN CASE WHEN j.status = 'draft' THEN j.status ELSE 'running' END
         WHEN EXISTS (SELECT 1 FROM job_wallets jw WHERE jw.job_id = j.id AND jw.status = 'failed') THEN 'failed'
         ELSE 'completed'
       END,
       updated_at = CURRENT_TIMESTAMP(3)
     WHERE j.id = ?`,
    [jobId],
  );
  const { maybeAutoRerunLoopJob } = await import("../normalized-job-db");
  await maybeAutoRerunLoopJob(jobId);
}

export async function recordWalletSuccess(
  walletRowId: number,
  jobId: string,
  txHash: string,
  rpcUrl: string,
): Promise<void> {
  const pool = await getMysqlPool();

  for (let attempt = 1; attempt <= WALLET_TX_DEADLOCK_RETRIES; attempt++) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.execute(
        `UPDATE job_wallets
         SET status = 'completed', tx_hash = ?, rpc_url = ?, error_message = NULL,
             next_attempt_at = NULL, assigned_worker = NULL, updated_at = CURRENT_TIMESTAMP(3)
         WHERE id = ?`,
        [txHash.slice(0, 128), rpcUrl.slice(0, 512), walletRowId],
      );
      await conn.execute(
        `UPDATE jobs SET processed_wallets = processed_wallets + 1, updated_at = CURRENT_TIMESTAMP(3) WHERE id = ?`,
        [jobId],
      );
      await refreshJobStatusOnlyConn(conn, jobId);
      await conn.commit();
      break;
    } catch (e) {
      await conn.rollback().catch(() => {});
      if (isMysqlDeadlock(e) && attempt < WALLET_TX_DEADLOCK_RETRIES) {
        await sleepMs(18 * attempt + Math.floor(Math.random() * 35));
        continue;
      }
      throw e;
    } finally {
      conn.release();
    }
  }

  const { maybeAutoRerunLoopJob } = await import("../normalized-job-db");
  await maybeAutoRerunLoopJob(jobId);

  markWalletCompleted();
}

export async function recordWalletFailure(
  walletRowId: number,
  jobId: string,
  errMsg: string,
  previousRetryCount: number,
): Promise<void> {
  const pool = await getMysqlPool();
  const maxAttempts = queueMaxAttempts();
  const nextRetry = previousRetryCount + 1;
  const terminal = nextRetry >= maxAttempts;

  for (let attempt = 1; attempt <= WALLET_TX_DEADLOCK_RETRIES; attempt++) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      if (terminal) {
        await conn.execute(
          `UPDATE job_wallets
           SET status = 'failed',
               retry_count = ?,
               error_message = ?,
               assigned_worker = NULL,
               next_attempt_at = NULL,
               updated_at = CURRENT_TIMESTAMP(3)
           WHERE id = ?`,
          [nextRetry, errMsg.slice(0, 8000), walletRowId],
        );
        await conn.execute(
          `UPDATE jobs SET failed_wallets = failed_wallets + 1, updated_at = CURRENT_TIMESTAMP(3) WHERE id = ?`,
          [jobId],
        );
      } else {
        const backoffMs = queueRetryBackoffMsForRetryCount(nextRetry);
        const nextAt = new Date(Date.now() + backoffMs);
        await conn.execute(
          `UPDATE job_wallets
           SET status = 'pending',
               retry_count = ?,
               error_message = ?,
               assigned_worker = NULL,
               next_attempt_at = ?,
               updated_at = CURRENT_TIMESTAMP(3)
           WHERE id = ?`,
          [nextRetry, errMsg.slice(0, 8000), nextAt, walletRowId],
        );
      }
      await refreshJobStatusOnlyConn(conn, jobId);
      await conn.commit();
      break;
    } catch (e) {
      await conn.rollback().catch(() => {});
      if (isMysqlDeadlock(e) && attempt < WALLET_TX_DEADLOCK_RETRIES) {
        await sleepMs(18 * attempt + Math.floor(Math.random() * 35));
        continue;
      }
      throw e;
    } finally {
      conn.release();
    }
  }

  const { maybeAutoRerunLoopJob } = await import("../normalized-job-db");
  await maybeAutoRerunLoopJob(jobId);
}

/** Recover rows stuck in processing (worker crash). */
export async function reconcileStaleProcessingRows(): Promise<number> {
  const pool = await getMysqlPool();
  const ms = queueStaleProcessingMs();
  const before = new Date(Date.now() - ms);
  const maxAttempts = queueMaxAttempts();
  const [result] = await pool.execute<ResultSetHeader>(
    `UPDATE job_wallets
     SET status = 'pending', assigned_worker = NULL, next_attempt_at = NULL, updated_at = CURRENT_TIMESTAMP(3)
     WHERE status = 'processing'
       AND updated_at < ?
       AND retry_count < ?`,
    [before, maxAttempts],
  );
  return result.affectedRows ?? 0;
}

export async function adminSetJobPaused(jobId: string, paused: boolean): Promise<void> {
  const pool = await getMysqlPool();
  await pool.execute(`UPDATE jobs SET paused = ?, updated_at = CURRENT_TIMESTAMP(3) WHERE id = ?`, [
    paused ? 1 : 0,
    jobId,
  ]);
  await refreshJobAggregates(jobId);
}

/**
 * Move `failed` wallet rows back to `pending` for another pass. Recomputes aggregates per affected job.
 * @param jobId — when set, only that job; otherwise all failed rows in the table.
 */
export async function adminRetryFailedWallets(jobId?: string): Promise<number> {
  const pool = await getMysqlPool();
  const [idRows] = await pool.execute<RowDataPacket[]>(
    jobId
      ? `SELECT DISTINCT job_id AS jid FROM job_wallets WHERE job_id = ? AND status = 'failed'`
      : `SELECT DISTINCT job_id AS jid FROM job_wallets WHERE status = 'failed'`,
    jobId ? [jobId] : [],
  );
  if (idRows.length === 0) return 0;
  const [result] = await pool.execute<ResultSetHeader>(
    jobId
      ? `UPDATE job_wallets
         SET status = 'pending', retry_count = 0, error_message = NULL, next_attempt_at = NULL,
             tx_hash = NULL, rpc_url = NULL, assigned_worker = NULL, updated_at = CURRENT_TIMESTAMP(3)
         WHERE job_id = ? AND status = 'failed'`
      : `UPDATE job_wallets
         SET status = 'pending', retry_count = 0, error_message = NULL, next_attempt_at = NULL,
             tx_hash = NULL, rpc_url = NULL, assigned_worker = NULL, updated_at = CURRENT_TIMESTAMP(3)
         WHERE status = 'failed'`,
    jobId ? [jobId] : [],
  );
  for (const r of idRows) {
    await refreshJobAggregates(String((r as { jid: string }).jid));
  }
  return result.affectedRows ?? 0;
}

/**
 * Requeue every non-completed wallet for a job (failed, processing, pending get normalized to pending).
 * Use after incidents or to “restart” a run without duplicating the job.
 */
export async function adminRequeueIncompleteJob(jobId: string): Promise<number> {
  const pool = await getMysqlPool();
  const [result] = await pool.execute<ResultSetHeader>(
    `UPDATE job_wallets
     SET status = 'pending', retry_count = 0, error_message = NULL, next_attempt_at = NULL,
         tx_hash = NULL, rpc_url = NULL, assigned_worker = NULL, updated_at = CURRENT_TIMESTAMP(3)
     WHERE job_id = ? AND status != 'completed'`,
    [jobId],
  );
  await refreshJobAggregates(jobId);
  return result.affectedRows ?? 0;
}

/** Draft jobs are never claimed — use after migration or if Start did not run. */
export async function adminPromoteDraftToQueued(jobId: string): Promise<boolean> {
  const pool = await getMysqlPool();
  const [result] = await pool.execute<ResultSetHeader>(
    `UPDATE jobs
     SET status = 'queued',
         queued_at = COALESCE(queued_at, CURRENT_TIMESTAMP(3)),
         paused = 0,
         updated_at = CURRENT_TIMESTAMP(3)
     WHERE id = ? AND status = 'draft'`,
    [jobId],
  );
  if ((result.affectedRows ?? 0) !== 1) return false;
  await refreshJobAggregates(jobId);
  return true;
}

export type QueueClaimDiagnostics = {
  globalPaused: boolean;
  maxAttempts: number;
  /** Rows the worker would claim right now (same filters as {@link claimWalletBatch}). */
  matchingClaimSql: number;
  walletsByStatus: Record<string, number>;
  pendingButDraftJob: number;
  /** Pending rows whose job is not `queued`/`running` or is paused — worker will skip them. */
  pendingBlockedByJobState: number;
  pendingBackoffFuture: number;
  pendingRetryCap: number;
  sampleJobsWithWork: Array<{
    id: string;
    status: string;
    paused: number;
    pending: number;
    processing: number;
  }>;
};

/** Operator/debug: why `claimWalletBatch` might return no rows. */
export async function getQueueClaimDiagnostics(): Promise<QueueClaimDiagnostics> {
  const pool = await getMysqlPool();
  const maxAttempts = queueMaxAttempts();
  const gp = queueGlobalPaused();

  const [matchRows] = await pool.execute<RowDataPacket[]>(
    `SELECT COUNT(*) AS c FROM job_wallets jw
     INNER JOIN jobs j ON j.id = jw.job_id
     WHERE jw.status = 'pending'
       AND (jw.next_attempt_at IS NULL OR jw.next_attempt_at <= CURRENT_TIMESTAMP(3))
       AND jw.retry_count < ?
       AND j.status IN ('queued', 'running')
       AND j.paused = 0`,
    [maxAttempts],
  );
  const matchingClaimSql = Number((matchRows[0] as { c: number }).c ?? 0);

  const [statusRows] = await pool.execute<RowDataPacket[]>(
    `SELECT status, COUNT(*) AS c FROM job_wallets GROUP BY status`,
  );
  const walletsByStatus: Record<string, number> = {};
  for (const r of statusRows) {
    walletsByStatus[String(r.status)] = Number(r.c ?? 0);
  }

  const [draftRows] = await pool.execute<RowDataPacket[]>(
    `SELECT COUNT(*) AS c FROM job_wallets jw
     INNER JOIN jobs j ON j.id = jw.job_id
     WHERE jw.status = 'pending' AND j.status = 'draft'`,
  );
  const pendingButDraftJob = Number((draftRows[0] as { c: number }).c ?? 0);

  const [blockedRows] = await pool.execute<RowDataPacket[]>(
    `SELECT COUNT(*) AS c FROM job_wallets jw
     INNER JOIN jobs j ON j.id = jw.job_id
     WHERE jw.status = 'pending'
       AND (
         j.status NOT IN ('queued', 'running')
         OR j.paused <> 0
       )`,
  );
  const pendingBlockedByJobState = Number((blockedRows[0] as { c: number }).c ?? 0);

  const [backoffRows] = await pool.execute<RowDataPacket[]>(
    `SELECT COUNT(*) AS c FROM job_wallets jw
     WHERE jw.status = 'pending'
       AND jw.next_attempt_at IS NOT NULL
       AND jw.next_attempt_at > CURRENT_TIMESTAMP(3)`,
  );
  const pendingBackoffFuture = Number((backoffRows[0] as { c: number }).c ?? 0);

  const [capRows] = await pool.execute<RowDataPacket[]>(
    `SELECT COUNT(*) AS c FROM job_wallets jw
     WHERE jw.status = 'pending' AND jw.retry_count >= ?`,
    [maxAttempts],
  );
  const pendingRetryCap = Number((capRows[0] as { c: number }).c ?? 0);

  const [sampleRows] = await pool.execute<RowDataPacket[]>(
    `SELECT j.id, j.status, j.paused,
            (SELECT COUNT(*) FROM job_wallets jw WHERE jw.job_id = j.id AND jw.status = 'pending') AS pend,
            (SELECT COUNT(*) FROM job_wallets jw WHERE jw.job_id = j.id AND jw.status = 'processing') AS proc
     FROM jobs j
     WHERE EXISTS (
       SELECT 1 FROM job_wallets jw
       WHERE jw.job_id = j.id AND jw.status IN ('pending', 'processing')
     )
     ORDER BY j.updated_at DESC
     LIMIT 12`,
  );
  const sampleJobsWithWork = sampleRows.map((r) => ({
    id: String(r.id),
    status: String(r.status),
    paused: Number(r.paused ?? 0),
    pending: Number(r.pend ?? 0),
    processing: Number(r.proc ?? 0),
  }));

  return {
    globalPaused: gp,
    maxAttempts,
    matchingClaimSql,
    walletsByStatus,
    pendingButDraftJob,
    pendingBlockedByJobState,
    pendingBackoffFuture,
    pendingRetryCap,
    sampleJobsWithWork,
  };
}

/** Draft jobs that still have pending wallet rows (invalid / orphan risk until promoted). */
export async function adminListDraftJobIdsWithPendingWallets(): Promise<string[]> {
  const pool = await getMysqlPool();
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT DISTINCT j.id FROM jobs j
     INNER JOIN job_wallets jw ON jw.job_id = j.id
     WHERE j.status = 'draft' AND jw.status = 'pending'`,
  );
  return rows.map((r) => String((r as { id: string }).id));
}

/** Reset stale processing rows, optionally promote orphan drafts that have pending wallets. */
export async function adminRecoverStalledQueue(options?: { promoteDrafts?: boolean }): Promise<{
  staleProcessingReset: number;
  draftJobsPromoted: number;
}> {
  const promoteDrafts = options?.promoteDrafts !== false;
  const staleProcessingReset = await reconcileStaleProcessingRows();
  let draftJobsPromoted = 0;
  if (promoteDrafts) {
    const ids = await adminListDraftJobIdsWithPendingWallets();
    for (const id of ids) {
      if (await adminPromoteDraftToQueued(id)) draftJobsPromoted++;
    }
  }
  return { staleProcessingReset, draftJobsPromoted };
}
