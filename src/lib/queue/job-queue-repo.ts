import type { PoolClient } from "pg";
import { assertSignerCountWithinJobLimit } from "../airdrop-signer-limits";
import { safeRollbackPgClient } from "../postgres-rollback";
import { getPostgresPool, pgExecute, pgQuery } from "../postgres";
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
  queueStaleProcessingThresholdMs,
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
import { getBatchForOwner } from "../generated-wallet-repo";
import { randomAmountsInRangeNative, randomAmountsInRangeToken } from "../split-amounts";
import { getQueueRuntimeFlagsSync, refreshQueueRuntimeCache } from "./queue-runtime-settings";
import type { ClaimedWalletRow, NormalizedJobRow } from "./types";
import {
  CLAIM_BACKFILL_SIGNER_FROM_JOB,
  CLAIM_ES_JW_J,
  CLAIM_ES_PX_JP,
  CLAIM_JOB_ELIGIBLE_WHERE,
  CLAIM_WALLET_ORDER_BY_JW_J,
} from "./claim-select-sql";

/** Throttle structured logs when claim returns 0 while SQL still sees claimable pending rows. */
let lastClaimStarvationLogMs = 0;
const CLAIM_STARVATION_LOG_COOLDOWN_MS = 60_000;

/** Drive job.status from wallet states — no COUNT(*) on job_wallets (hot path). */
const REFRESH_JOB_STATUS_SQL = `UPDATE jobs j
     SET
       status = CASE
         WHEN j.paused IS TRUE THEN j.status
         WHEN j.status IN ('draft', 'cancelled') THEN j.status
         WHEN EXISTS (
           SELECT 1 FROM job_wallets jw
           WHERE jw.job_id = j.id AND jw.status IN ('pending', 'processing')
         ) THEN CASE WHEN j.status = 'draft' THEN j.status ELSE 'running' END
         WHEN EXISTS (SELECT 1 FROM job_wallets jw WHERE jw.job_id = j.id AND jw.status = 'failed') THEN 'failed'
         ELSE 'completed'
       END,
       updated_at = NOW()
     WHERE j.id = ?`;

async function refreshJobStatusOnlyConn(conn: PoolClient, jobId: string): Promise<void> {
  await pgExecute(conn, REFRESH_JOB_STATUS_SQL, [jobId]);
}

function isPostgresDeadlock(e: unknown): boolean {
  const x = e as { code?: string };
  return x.code === "40P01";
}

async function sleepMs(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/** Deadlocks when parallel txs touch the same `jobs` row — retry whole transaction. */
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

function rowToNormalizedJob(row: Record<string, unknown>): NormalizedJobRow {
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
    scheduledAt: row.scheduled_at != null ? new Date(row.scheduled_at as string | Date).toISOString() : null,
    queuedAt: row.queued_at != null ? new Date(row.queued_at as string | Date).toISOString() : null,
    targetRunCount: row.target_run_count != null ? Number(row.target_run_count) : 1,
    currentRun: row.current_run != null ? Number(row.current_run) : 1,
    loopForever: Boolean(row.loop_forever),
    signerAddress: row.signer_address != null ? String(row.signer_address) : null,
    signerAddresses: signers,
    createdAt: new Date(row.created_at as string | Date).toISOString(),
    updatedAt: new Date(row.updated_at as string | Date).toISOString(),
  };
}

export async function getNormalizedJob(jobId: string): Promise<NormalizedJobRow | undefined> {
  const pool = await getPostgresPool();
  const rows = await pgQuery<Record<string, unknown>>(pool, "SELECT * FROM jobs WHERE id = ?", [jobId]);
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

/** Round-robin assigns recipients to signers so each signer gets within one row of floor(n/s) wallets. */
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
  assertSignerCountWithinJobLimit(distributors);

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
  const pool = await getPostgresPool();
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
  const conn = await pool.connect();
  try {
    await conn.query("BEGIN");
    await pgExecute(
      conn,
      `INSERT INTO jobs (
        id, owner, name, status, total_wallets, processed_wallets, failed_wallets,
        mode, token_address, chain_id, paused, scheduled_at, queued_at,
        target_run_count, current_run, loop_forever, signer_address, signer_addresses_json
      ) VALUES (?, ?, ?, 'draft', ?, 0, 0, ?, ?, ?, FALSE, NULL, NULL, ?, 1, ?, ?, ?::jsonb)`,
      [
        input.jobId,
        input.ownerLower,
        input.name?.trim() || null,
        expanded.length,
        input.mode,
        input.mode === "erc20" ? input.tokenAddress ?? null : null,
        input.chainId,
        targetRuns,
        input.loopForever,
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
      await pgExecute(
        conn,
        `INSERT INTO job_wallets (job_id, wallet_address, amount, status, signer_address) VALUES ${placeholders}`,
        flat,
      );
    }

    await conn.query("COMMIT");
  } catch (e) {
    await conn.query("ROLLBACK");
    throw e;
  } finally {
    conn.release();
  }
}

export type CreateNormalizedJobFromBatchInput = {
  jobId: string;
  ownerLower: string;
  name?: string | null;
  mode: "native" | "erc20";
  tokenAddress?: string | null;
  chainId: number;
  signerAddresses: string[];
  generatedBatchId: string;
  /** Inclusive 1-based indices (first generated wallet = 1). */
  fromWalletIndex: number;
  toWalletIndex: number;
  loopForever?: boolean;
  /** Same decimal string for every recipient row. */
  amountMode: "uniform";
  uniformAmount: string;
} | {
  jobId: string;
  ownerLower: string;
  name?: string | null;
  mode: "native" | "erc20";
  tokenAddress?: string | null;
  chainId: number;
  signerAddresses: string[];
  generatedBatchId: string;
  fromWalletIndex: number;
  toWalletIndex: number;
  loopForever?: boolean;
  /** Independent random amount per row in [minAmount, maxAmount]. */
  amountMode: "randomRange";
  minAmount: string;
  maxAmount: string;
  /** ERC-20 token decimals (native mode ignores). */
  tokenDecimals: number;
};

const JOB_WALLET_FROM_GENERATED_CHUNK = 2500;

/**
 * Creates a draft job and fills `job_wallets` from `generated_wallets` (addresses only; distributor signers send transfers).
 * @returns number of wallet rows inserted
 */
export async function createNormalizedJobFromGeneratedBatch(input: CreateNormalizedJobFromBatchInput): Promise<number> {
  const batch = await getBatchForOwner(input.generatedBatchId, input.ownerLower);
  if (!batch) throw new Error("Wallet batch not found");
  if (batch.status !== "completed") throw new Error("Wallet batch must be completed before creating a job from it");
  if (batch.inserted_wallets < batch.total_wallets) throw new Error("Batch generation incomplete");

  const fromIdx = Math.floor(Number(input.fromWalletIndex));
  const toIdx = Math.floor(Number(input.toWalletIndex));
  if (!Number.isFinite(fromIdx) || !Number.isFinite(toIdx)) throw new Error("Invalid wallet index range");
  if (fromIdx < 1 || toIdx < fromIdx || toIdx > batch.total_wallets) {
    throw new Error(`Invalid wallet index range (allowed 1–${batch.total_wallets}, inclusive)`);
  }

  const pool = await getPostgresPool();
  const cntRows = await pgQuery<{ c: string }>(
    pool,
    `SELECT COUNT(*)::text AS c FROM generated_wallets
     WHERE batch_id = ?::uuid AND wallet_index BETWEEN ? AND ?`,
    [input.generatedBatchId, fromIdx, toIdx],
  );
  const cnt = Number(cntRows[0]?.c ?? 0);
  const expected = toIdx - fromIdx + 1;
  if (cnt !== expected) {
    throw new Error(`Range not fully populated in database (expected ${expected} rows, found ${cnt})`);
  }

  const uniformMode = input.amountMode === "uniform";
  if (uniformMode) {
    const amt = Number(input.uniformAmount);
    if (!Number.isFinite(amt) || amt < 0) throw new Error("Invalid uniform amount");
  } else {
    const lo = Number(input.minAmount);
    const hi = Number(input.maxAmount);
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo < 0 || hi < lo) {
      throw new Error("Invalid min/max amounts for random range");
    }
  }

  const distributors = [...new Set(input.signerAddresses.map((a) => a.toLowerCase()))];
  if (!distributors.length) throw new Error("No distributor wallets");
  assertSignerCountWithinJobLimit(distributors);
  const signersJson = JSON.stringify(distributors);

  const conn = await pool.connect();
  try {
    await conn.query("BEGIN");
    await pgExecute(
      conn,
      `INSERT INTO jobs (
        id, owner, name, status, total_wallets, processed_wallets, failed_wallets,
        mode, token_address, chain_id, paused, scheduled_at, queued_at,
        target_run_count, current_run, loop_forever, signer_address, signer_addresses_json
      ) VALUES (?, ?, ?, 'draft', ?, 0, 0, ?, ?, ?, FALSE, NULL, NULL, 1, 1, ?, ?, ?::jsonb)`,
      [
        input.jobId,
        input.ownerLower,
        input.name?.trim() || null,
        expected,
        input.mode,
        input.mode === "erc20" ? input.tokenAddress ?? null : null,
        input.chainId,
        input.loopForever ?? false,
        distributors[0] ?? null,
        signersJson,
      ],
    );

    const uniformStr = uniformMode ? input.uniformAmount : "";

    if (uniformMode && distributors.length === 1) {
      await pgExecute(
        conn,
        `INSERT INTO job_wallets (job_id, wallet_address, amount, status, signer_address)
         SELECT ?::varchar(64), lower(gw.address)::varchar(66), ?::varchar(128), 'pending', ?::varchar(66)
         FROM generated_wallets gw
         WHERE gw.batch_id = ?::uuid AND gw.wallet_index BETWEEN ? AND ?
         ORDER BY gw.wallet_index`,
        [input.jobId, uniformStr, distributors[0]!, input.generatedBatchId, fromIdx, toIdx],
      );
    } else {
      let cur = fromIdx;
      while (cur <= toIdx) {
        const hi = Math.min(cur + JOB_WALLET_FROM_GENERATED_CHUNK - 1, toIdx);
        const slice = await pgQuery<{
          wallet_index: number;
          address: string;
        }>(
          conn,
          `SELECT wallet_index, address FROM generated_wallets
           WHERE batch_id = ?::uuid AND wallet_index BETWEEN ? AND ?
           ORDER BY wallet_index ASC`,
          [input.generatedBatchId, cur, hi],
        );
        const n = slice.length;
        let amounts: string[] = [];
        if (uniformMode) {
          amounts = Array.from({ length: n }, () => uniformStr);
        } else if (input.mode === "native") {
          amounts = randomAmountsInRangeNative(input.minAmount, input.maxAmount, n);
        } else {
          amounts = randomAmountsInRangeToken(input.minAmount, input.maxAmount, n, input.tokenDecimals);
        }
        const placeholders = slice.map(() => "(?, ?, ?, 'pending', ?)").join(", ");
        const flat: unknown[] = [];
        for (let i = 0; i < slice.length; i++) {
          const row = slice[i]!;
          const signer = distributors[(row.wallet_index - fromIdx) % distributors.length]!;
          flat.push(input.jobId, row.address.toLowerCase(), amounts[i]!, signer);
        }
        if (flat.length) {
          await pgExecute(
            conn,
            `INSERT INTO job_wallets (job_id, wallet_address, amount, status, signer_address) VALUES ${placeholders}`,
            flat,
          );
        }
        cur = hi + 1;
      }
    }

    await conn.query("COMMIT");
    return expected;
  } catch (e) {
    await conn.query("ROLLBACK");
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
  const pool = await getPostgresPool();
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

  const conn = await pool.connect();
  try {
    await conn.query("BEGIN");
    const check = await pgQuery<Record<string, unknown>>(
      conn,
      `SELECT id, status, owner FROM jobs WHERE id = ? LIMIT 1 FOR UPDATE`,
      [input.jobId],
    );
    const row = check[0];
    if (!row) throw new Error("Job not found");
    if (String(row.owner).toLowerCase() !== input.ownerLower) throw new Error("Forbidden");
    if (String(row.status) !== "draft") throw new Error("Only draft jobs can edit recipients");

    await pgExecute(conn, `DELETE FROM job_wallets WHERE job_id = ?`, [input.jobId]);

    await pgExecute(
      conn,
      `UPDATE jobs SET
        name = COALESCE(?, name),
        mode = ?,
        token_address = ?,
        chain_id = ?,
        signer_address = ?,
        signer_addresses_json = ?::jsonb,
        target_run_count = ?,
        total_wallets = ?,
        processed_wallets = 0,
        failed_wallets = 0,
        updated_at = NOW()
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
      await pgExecute(
        conn,
        `INSERT INTO job_wallets (job_id, wallet_address, amount, status, signer_address) VALUES ${placeholders}`,
        flat,
      );
    }

    await conn.query("COMMIT");
  } catch (e) {
    await conn.query("ROLLBACK");
    throw e;
  } finally {
    conn.release();
  }
  await refreshJobAggregates(input.jobId);
}

export async function startNormalizedJob(jobId: string, ownerLower: string): Promise<boolean> {
  const pool = await getPostgresPool();
  const result = await pgExecute(
    pool,
    `UPDATE jobs
     SET status = 'queued', queued_at = NOW(), paused = FALSE, updated_at = NOW()
     WHERE id = ? AND owner = ? AND status = 'draft'`,
    [jobId, ownerLower],
  );
  return result.rowCount === 1;
}

/**
 * Dashboard "Start now": unblocks claiming for a job stuck in `queued` or user-paused `running` → `paused`.
 * Sets `running`, clears schedule, and unpauses when there is pending or in-flight wallet work.
 */
export async function unpauseNormalizedJobNow(jobId: string, ownerLower: string): Promise<boolean> {
  const pool = await getPostgresPool();
  const result = await pgExecute(
    pool,
    `UPDATE jobs j
     SET paused = FALSE,
         scheduled_at = NULL,
         status = 'running',
         queued_at = COALESCE(j.queued_at, NOW()),
         updated_at = NOW()
     WHERE j.id = ?
       AND j.owner = ?
       AND j.status IN ('queued', 'paused')
       AND EXISTS (
         SELECT 1 FROM job_wallets jw
         WHERE jw.job_id = j.id AND jw.status IN ('pending', 'processing')
       )`,
    [jobId, ownerLower],
  );
  return result.rowCount === 1;
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
  const pool = await getPostgresPool();
  const batch = queueClaimBatchSize();
  const maxAttempts = queueMaxAttempts();

  let pendingApprox = 0;
  let pendingStrictApprox = 0;
  let queuedJobsApprox = 0;
  if (diag) {
    try {
      const ps = await pgQuery<{ c: string }>(
        pool,
        `SELECT COUNT(*)::text AS c FROM job_wallets WHERE status = 'pending'`,
      );
      pendingStrictApprox = Number(ps[0]?.c ?? 0);
      const pr = await pgQuery<{ c: string }>(
        pool,
        `SELECT COUNT(*)::text AS c FROM job_wallets WHERE status IN ('pending','processing')`,
      );
      pendingApprox = Number(pr[0]?.c ?? 0);
      const qj = await pgQuery<{ c: string }>(
        pool,
        `SELECT COUNT(*)::text AS c FROM jobs WHERE status IN ('queued','running')`,
      );
      queuedJobsApprox = Number(qj[0]?.c ?? 0);
      const flags = getQueueRuntimeFlagsSync();
      console.info(
        `[claim-diag] flags processing=${flags.processingEnabled} normalized_queue_v2=${flags.normalizedQueueV2} AIRDROP_QUEUE_V2=${process.env.AIRDROP_QUEUE_V2} globalPaused=${queueGlobalPaused()} pendingStrict~=${pendingStrictApprox} pendingOrProcessing~=${pendingApprox} queuedJobs~=${queuedJobsApprox}`,
      );
      console.info(`[claim-diag] pool ${JSON.stringify(poolDiagnostics(pool))}`);
      if (isSqlExplainEnabled()) {
        try {
          const expl = await pgQuery<Record<string, unknown>>(pool, `EXPLAIN (FORMAT JSON) ${CLAIM_SELECT_DIAG_SQL}`, [
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

  const conn = await pool.connect();
  const txT0 = diag ? performance.now() : 0;
  try {
    await conn.query("BEGIN");
    if (diag) {
      const iso = await sessionIsolation(conn);
      console.info(`[claim-diag] tx_begin_ms=${Math.round(performance.now() - txT0)} isolation=${iso ?? "?"}`);
    }
    /**
     * Two-stage claim: PostgreSQL forbids `SELECT DISTINCT … FOR UPDATE` on the same SELECT.
     * Stage A — candidates inside a subquery (DISTINCT ON signer, no lock).
     * Stage B — lock real `job_wallets` rows with `FOR UPDATE OF jw SKIP LOCKED`.
     */
    const claimPickSub = `SELECT DISTINCT ON (lower(trim(${CLAIM_ES_JW_J})))
       jw.id AS id, jw.job_id AS "jobId", jw.wallet_address AS "walletAddress", jw.amount AS amount,
              jw.retry_count AS "retryCount", (${CLAIM_ES_JW_J}) AS "signerAddress",
              j.owner AS owner, j.mode AS mode, j.token_address AS "tokenAddress", j.chain_id AS "chainId"
       FROM job_wallets jw
       INNER JOIN jobs j ON j.id = jw.job_id
       WHERE jw.status = 'pending'
         AND (jw.next_attempt_at IS NULL OR jw.next_attempt_at <= NOW())
         AND jw.retry_count < ?
         AND ${CLAIM_JOB_ELIGIBLE_WHERE}
         AND (${CLAIM_ES_JW_J}) IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM job_wallets px
           INNER JOIN jobs jp ON jp.id = px.job_id
           WHERE px.status = 'processing'
             AND lower(trim(${CLAIM_ES_PX_JP})) = lower(trim(${CLAIM_ES_JW_J}))
         )
       ORDER BY lower(trim(${CLAIM_ES_JW_J})), ${CLAIM_WALLET_ORDER_BY_JW_J}
       LIMIT ?`;
    const sql = `SELECT picked.id AS id, picked."jobId" AS "jobId", picked."walletAddress" AS "walletAddress",
       picked.amount AS amount, picked."retryCount" AS "retryCount", picked."signerAddress" AS "signerAddress",
       picked.owner AS owner, picked.mode AS mode, picked."tokenAddress" AS "tokenAddress", picked."chainId" AS "chainId"
       FROM (${claimPickSub}) picked
       INNER JOIN job_wallets jw ON jw.id = picked.id
       INNER JOIN jobs j ON j.id = jw.job_id
       FOR UPDATE OF jw SKIP LOCKED`;
    if (diag) console.info("[claim-diag] claim_sql=", sql.replace(/\s+/g, " ").slice(0, 220) + "…");

    const selT0 = performance.now();
    const rows = await pgQuery<Record<string, unknown>>(conn, sql, [maxAttempts, batch]);
    const selMs = Math.round(performance.now() - selT0);

    if (!rows.length) {
      await conn.query("COMMIT");
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
      const blockersPost = collectQueueClaimBlockers();
      if (!blockersPost.length) {
        const now = Date.now();
        if (now - lastClaimStarvationLogMs >= CLAIM_STARVATION_LOG_COOLDOWN_MS) {
          try {
            const d = await getQueueClaimDiagnostics();
            if (d.matchingClaimSql > 0) {
              lastClaimStarvationLogMs = now;
              const staleBefore = new Date(Date.now() - queueStaleProcessingThresholdMs());
              const staleRows = await pgQuery<{ c: string }>(
                pool,
                `SELECT COUNT(*)::text AS c FROM job_wallets WHERE status = 'processing' AND updated_at < ?`,
                [staleBefore],
              );
              const jobQ = await pgQuery<{ c: string }>(
                pool,
                `SELECT COUNT(*)::text AS c FROM jobs WHERE status IN ('queued', 'running') AND paused IS NOT TRUE`,
              );
              console.warn(
                JSON.stringify({
                  event: "queue_claim_empty_but_sql_matches_pending",
                  workerId: workerId.slice(0, 64),
                  claimBatchSize: batch,
                  claimablePendingApprox: d.matchingClaimSql,
                  queueGlobalPaused: d.globalPaused,
                  processingEnabled: getQueueRuntimeFlagsSync().processingEnabled,
                  normalizedQueueV2: getQueueRuntimeFlagsSync().normalizedQueueV2,
                  activeQueuedOrRunningUnpausedJobs: Number(jobQ[0]?.c ?? 0),
                  processingStaleBeyondThreshold: Number(staleRows[0]?.c ?? 0),
                  walletsByStatus: d.walletsByStatus,
                  pendingBlockedByJobState: d.pendingBlockedByJobState,
                  pendingBackoffFuture: d.pendingBackoffFuture,
                  pendingRetryCap: d.pendingRetryCap,
                  reason:
                    "Claim SELECT returned 0 while a simpler pending COUNT is >0 — signer blocked by global processing, SKIP_LOCKED contention, DISTINCT ON signer starvation, or stale processing rows not yet reset.",
                }),
              );
            }
          } catch (logErr) {
            console.warn("[queue-claim] claim_starvation_snapshot_failed", logErr);
          }
        }
      }
      return [];
    }

    const ids = rows.map((r) => Number(r.id));
    const ph = ids.map(() => "?").join(",");
    const updT0 = performance.now();
    try {
      await pgExecute(
        conn,
        `UPDATE job_wallets jw
         SET status = 'processing',
             assigned_worker = ?,
             updated_at = NOW(),
             signer_address = ${CLAIM_BACKFILL_SIGNER_FROM_JOB}
         FROM jobs j
         WHERE j.id = jw.job_id AND jw.id IN (${ph})`,
        [workerId.slice(0, 64), ...ids],
      );
    } catch (e) {
      const code = e && typeof e === "object" && "code" in e ? String((e as { code: string }).code) : "";
      if (code === "23505") {
        await safeRollbackPgClient(
          conn,
          `claimWalletBatch:23505_unique_processing_per_signer worker=${workerId.slice(0, 48)}`,
        );
        console.error(
          JSON.stringify({
            event: "claim_wallet_batch_rollback",
            code: "23505",
            workerId: workerId.slice(0, 64),
            selectedIds: ids.slice(0, 24),
            message: "Concurrent claim hit partial unique index idx_job_wallets_one_processing_per_signer",
          }),
        );
        if (diag) console.warn("[claim-diag] unique idx_job_wallets_one_processing_per_signer — concurrent claim; retrying later");
        return [];
      }
      throw e;
    }
    if (diag) console.info(`[claim-diag] update_processing_ms=${Math.round(performance.now() - updT0)} ids=${ids.length}`);

    const jobIds = [...new Set(rows.map((r) => String(r.jobId)))];
    for (const jid of jobIds) {
      await pgExecute(
        conn,
        `UPDATE jobs SET status = 'running', updated_at = NOW() WHERE id = ? AND status = 'queued'`,
        [jid],
      );
    }

    const commitT0 = performance.now();
    await conn.query("COMMIT");
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
    await safeRollbackPgClient(
      conn,
      `claimWalletBatch:outer_catch ${e instanceof Error ? e.message : String(e)}`,
    );
    console.error("[claim-wallet] transaction aborted", e instanceof Error ? e.stack ?? e.message : e);
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
  const pool = await getPostgresPool();
  const batch = queueClaimBatchSize();
  const maxAttempts = queueMaxAttempts();
  const conn = await pool.connect();
  try {
    await conn.query("BEGIN");
    const claimPickSub = `SELECT DISTINCT ON (lower(trim(${CLAIM_ES_JW_J})))
       jw.id AS id, jw.job_id AS "jobId", jw.wallet_address AS "walletAddress", jw.amount AS amount,
              jw.retry_count AS "retryCount", (${CLAIM_ES_JW_J}) AS "signerAddress",
              j.owner AS owner, j.mode AS mode, j.token_address AS "tokenAddress", j.chain_id AS "chainId"
       FROM job_wallets jw
       INNER JOIN jobs j ON j.id = jw.job_id
       WHERE jw.status = 'pending'
         AND (jw.next_attempt_at IS NULL OR jw.next_attempt_at <= NOW())
         AND jw.retry_count < ?
         AND ${CLAIM_JOB_ELIGIBLE_WHERE}
         AND (${CLAIM_ES_JW_J}) IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM job_wallets px
           INNER JOIN jobs jp ON jp.id = px.job_id
           WHERE px.status = 'processing'
             AND lower(trim(${CLAIM_ES_PX_JP})) = lower(trim(${CLAIM_ES_JW_J}))
         )
       ORDER BY lower(trim(${CLAIM_ES_JW_J})), ${CLAIM_WALLET_ORDER_BY_JW_J}
       LIMIT ?`;
    const sql = `SELECT picked.id AS id, picked."jobId" AS "jobId", picked."walletAddress" AS "walletAddress",
       picked.amount AS amount, picked."retryCount" AS "retryCount", picked."signerAddress" AS "signerAddress",
       picked.owner AS owner, picked.mode AS mode, picked."tokenAddress" AS "tokenAddress", picked."chainId" AS "chainId"
       FROM (${claimPickSub}) picked
       INNER JOIN job_wallets jw ON jw.id = picked.id
       INNER JOIN jobs j ON j.id = jw.job_id
       FOR UPDATE OF jw SKIP LOCKED`;
    const rows = await pgQuery<Record<string, unknown>>(conn, sql, [maxAttempts, batch]);
    if (!rows.length) {
      await conn.query("COMMIT");
      return [];
    }
    const ids = rows.map((r) => Number(r.id));
    const ph = ids.map(() => "?").join(",");
    await pgExecute(
      conn,
      `UPDATE job_wallets jw
       SET status = 'processing',
           assigned_worker = ?,
           updated_at = NOW(),
           signer_address = ${CLAIM_BACKFILL_SIGNER_FROM_JOB}
       FROM jobs j
       WHERE j.id = jw.job_id AND jw.id IN (${ph})`,
      [workerId.slice(0, 64), ...ids],
    );
    const jobIds = [...new Set(rows.map((r) => String(r.jobId)))];
    for (const jid of jobIds) {
      await pgExecute(
        conn,
        `UPDATE jobs SET status = 'running', updated_at = NOW() WHERE id = ? AND status = 'queued'`,
        [jid],
      );
    }
    await safeRollbackPgClient(conn, "claimWalletBatchDryRun:intentional_rollback_after_update_simulation");
    return ids;
  } catch (e) {
    await safeRollbackPgClient(conn, `claimWalletBatchDryRun:catch ${e instanceof Error ? e.message : String(e)}`);
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
  const pool = await getPostgresPool();
  await pgExecute(
    pool,
    `UPDATE jobs j
     SET
       processed_wallets = (SELECT COUNT(*)::int FROM job_wallets jw WHERE jw.job_id = j.id AND jw.status = 'completed'),
       failed_wallets = (SELECT COUNT(*)::int FROM job_wallets jw WHERE jw.job_id = j.id AND jw.status = 'failed'),
       total_wallets = (SELECT COUNT(*)::int FROM job_wallets jw WHERE jw.job_id = j.id),
       status = CASE
         WHEN j.paused IS TRUE THEN j.status
         WHEN j.status IN ('draft', 'cancelled') THEN j.status
         WHEN EXISTS (
           SELECT 1 FROM job_wallets jw
           WHERE jw.job_id = j.id AND jw.status IN ('pending', 'processing')
         ) THEN CASE WHEN j.status = 'draft' THEN j.status ELSE 'running' END
         WHEN EXISTS (SELECT 1 FROM job_wallets jw WHERE jw.job_id = j.id AND jw.status = 'failed') THEN 'failed'
         ELSE 'completed'
       END,
       updated_at = NOW()
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
  const pool = await getPostgresPool();

  for (let attempt = 1; attempt <= WALLET_TX_DEADLOCK_RETRIES; attempt++) {
    const conn = await pool.connect();
    try {
      await conn.query("BEGIN");
      await pgExecute(
        conn,
        `UPDATE job_wallets
         SET status = 'completed', tx_hash = ?, rpc_url = ?, error_message = NULL,
             next_attempt_at = NULL, assigned_worker = NULL, updated_at = NOW()
         WHERE id = ?`,
        [txHash.slice(0, 128), rpcUrl.slice(0, 512), walletRowId],
      );
      await pgExecute(
        conn,
        `UPDATE jobs SET processed_wallets = processed_wallets + 1, updated_at = NOW() WHERE id = ?`,
        [jobId],
      );
      await refreshJobStatusOnlyConn(conn, jobId);
      await conn.query("COMMIT");
      break;
    } catch (e) {
      await conn.query("ROLLBACK").catch(() => {});
      if (isPostgresDeadlock(e) && attempt < WALLET_TX_DEADLOCK_RETRIES) {
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
  const pool = await getPostgresPool();
  const maxAttempts = queueMaxAttempts();
  const nextRetry = previousRetryCount + 1;
  const terminal = nextRetry >= maxAttempts;

  for (let attempt = 1; attempt <= WALLET_TX_DEADLOCK_RETRIES; attempt++) {
    const conn = await pool.connect();
    try {
      await conn.query("BEGIN");
      if (terminal) {
        await pgExecute(
          conn,
          `UPDATE job_wallets
           SET status = 'failed',
               retry_count = ?,
               error_message = ?,
               assigned_worker = NULL,
               next_attempt_at = NULL,
               updated_at = NOW()
           WHERE id = ?`,
          [nextRetry, errMsg.slice(0, 8000), walletRowId],
        );
        await pgExecute(
          conn,
          `UPDATE jobs SET failed_wallets = failed_wallets + 1, updated_at = NOW() WHERE id = ?`,
          [jobId],
        );
      } else {
        const backoffMs = queueRetryBackoffMsForRetryCount(nextRetry);
        const nextAt = new Date(Date.now() + backoffMs);
        await pgExecute(
          conn,
          `UPDATE job_wallets
           SET status = 'pending',
               retry_count = ?,
               error_message = ?,
               assigned_worker = NULL,
               next_attempt_at = ?,
               updated_at = NOW()
           WHERE id = ?`,
          [nextRetry, errMsg.slice(0, 8000), nextAt, walletRowId],
        );
      }
      await refreshJobStatusOnlyConn(conn, jobId);
      await conn.query("COMMIT");
      break;
    } catch (e) {
      await conn.query("ROLLBACK").catch(() => {});
      if (isPostgresDeadlock(e) && attempt < WALLET_TX_DEADLOCK_RETRIES) {
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

/** Recover rows stuck in processing (worker crash). Preserves `retry_count`; appends audit text to `error_message`. */
export async function reconcileStaleProcessingRows(): Promise<number> {
  const pool = await getPostgresPool();
  const ms = queueStaleProcessingThresholdMs();
  const before = new Date(Date.now() - ms);
  const maxAttempts = queueMaxAttempts();
  const result = await pgExecute(
    pool,
    `UPDATE job_wallets
     SET status = 'pending',
         assigned_worker = NULL,
         next_attempt_at = NULL,
         error_message = LEFT(
           COALESCE(error_message, '') || ' | stale processing reset (was worker ' || COALESCE(assigned_worker, CHR(63)) || ')',
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

/**
 * Recompute `jobs.status` from `job_wallets` for every job that has wallet rows.
 * Fixes jobs left `running`/`queued` when all wallets are already terminal (completed/failed only).
 */
export async function reconcileAllJobStatusesFromWallets(): Promise<number> {
  const pool = await getPostgresPool();
  const result = await pgExecute(
    pool,
    `WITH computed AS (
       SELECT j.id,
         CASE
           WHEN j.paused IS TRUE THEN j.status
           WHEN j.status IN ('draft', 'cancelled') THEN j.status
           WHEN EXISTS (
             SELECT 1 FROM job_wallets jw
             WHERE jw.job_id = j.id AND jw.status IN ('pending', 'processing')
           ) THEN CASE WHEN j.status = 'draft' THEN j.status ELSE 'running' END
           WHEN EXISTS (
             SELECT 1 FROM job_wallets jw
             WHERE jw.job_id = j.id AND jw.status = 'failed'
           ) THEN 'failed'
           ELSE 'completed'
         END AS new_status
       FROM jobs j
       WHERE EXISTS (SELECT 1 FROM job_wallets jw WHERE jw.job_id = j.id)
     )
     UPDATE jobs j
     SET status = c.new_status,
         updated_at = NOW()
     FROM computed c
     WHERE j.id = c.id AND j.status IS DISTINCT FROM c.new_status`,
    [],
  );
  return result.rowCount ?? 0;
}

export async function adminSetJobPaused(jobId: string, paused: boolean): Promise<void> {
  const pool = await getPostgresPool();
  await pgExecute(pool, `UPDATE jobs SET paused = ?, updated_at = NOW() WHERE id = ?`, [paused, jobId]);
  await refreshJobAggregates(jobId);
}

/**
 * Move `failed` wallet rows back to `pending` for another pass. Recomputes aggregates per affected job.
 * @param jobId — when set, only that job; otherwise all failed rows in the table.
 */
export async function adminRetryFailedWallets(jobId?: string): Promise<number> {
  const pool = await getPostgresPool();
  const idRows = await pgQuery<{ jid: string }>(
    pool,
    jobId
      ? `SELECT DISTINCT job_id AS jid FROM job_wallets WHERE job_id = ? AND status = 'failed'`
      : `SELECT DISTINCT job_id AS jid FROM job_wallets WHERE status = 'failed'`,
    jobId ? [jobId] : [],
  );
  if (idRows.length === 0) return 0;
  const result = await pgExecute(
    pool,
    jobId
      ? `UPDATE job_wallets
         SET status = 'pending', retry_count = 0, error_message = NULL, next_attempt_at = NULL,
             tx_hash = NULL, rpc_url = NULL, assigned_worker = NULL, updated_at = NOW()
         WHERE job_id = ? AND status = 'failed'`
      : `UPDATE job_wallets
         SET status = 'pending', retry_count = 0, error_message = NULL, next_attempt_at = NULL,
             tx_hash = NULL, rpc_url = NULL, assigned_worker = NULL, updated_at = NOW()
         WHERE status = 'failed'`,
    jobId ? [jobId] : [],
  );
  for (const r of idRows) {
    await refreshJobAggregates(String(r.jid));
  }
  return result.rowCount ?? 0;
}

/**
 * Requeue every non-completed wallet for a job (failed, processing, pending get normalized to pending).
 * Use after incidents or to “restart” a run without duplicating the job.
 */
export async function adminRequeueIncompleteJob(jobId: string): Promise<number> {
  const pool = await getPostgresPool();
  const result = await pgExecute(
    pool,
    `UPDATE job_wallets
     SET status = 'pending', retry_count = 0, error_message = NULL, next_attempt_at = NULL,
         tx_hash = NULL, rpc_url = NULL, assigned_worker = NULL, updated_at = NOW()
     WHERE job_id = ? AND status != 'completed'`,
    [jobId],
  );
  await refreshJobAggregates(jobId);
  return result.rowCount ?? 0;
}

/** Draft jobs are never claimed — use after migration or if Start did not run. */
export async function adminPromoteDraftToQueued(jobId: string): Promise<boolean> {
  const pool = await getPostgresPool();
  const result = await pgExecute(
    pool,
    `UPDATE jobs
     SET status = 'queued',
         queued_at = COALESCE(queued_at, NOW()),
         paused = FALSE,
         updated_at = NOW()
     WHERE id = ? AND status = 'draft'`,
    [jobId],
  );
  if ((result.rowCount ?? 0) !== 1) return false;
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
  const pool = await getPostgresPool();
  const maxAttempts = queueMaxAttempts();
  const gp = queueGlobalPaused();

  const matchRows = await pgQuery<{ c: string }>(
    pool,
    `SELECT COUNT(*)::text AS c FROM job_wallets jw
     INNER JOIN jobs j ON j.id = jw.job_id
     WHERE jw.status = 'pending'
       AND (jw.next_attempt_at IS NULL OR jw.next_attempt_at <= NOW())
       AND jw.retry_count < ?
       AND (${CLAIM_JOB_ELIGIBLE_WHERE})
       AND (${CLAIM_ES_JW_J}) IS NOT NULL`,
    [maxAttempts],
  );
  const matchingClaimSql = Number(matchRows[0]?.c ?? 0);

  const statusRows = await pgQuery<{ status: string; c: string }>(
    pool,
    `SELECT status, COUNT(*)::text AS c FROM job_wallets GROUP BY status`,
  );
  const walletsByStatus: Record<string, number> = {};
  for (const r of statusRows) {
    walletsByStatus[String(r.status)] = Number(r.c ?? 0);
  }

  const draftRows = await pgQuery<{ c: string }>(
    pool,
    `SELECT COUNT(*)::text AS c FROM job_wallets jw
     INNER JOIN jobs j ON j.id = jw.job_id
     WHERE jw.status = 'pending' AND j.status = 'draft'`,
  );
  const pendingButDraftJob = Number(draftRows[0]?.c ?? 0);

  const blockedRows = await pgQuery<{ c: string }>(
    pool,
    `SELECT COUNT(*)::text AS c FROM job_wallets jw
     INNER JOIN jobs j ON j.id = jw.job_id
     WHERE jw.status = 'pending'
       AND NOT (${CLAIM_JOB_ELIGIBLE_WHERE})`,
  );
  const pendingBlockedByJobState = Number(blockedRows[0]?.c ?? 0);

  const backoffRows = await pgQuery<{ c: string }>(
    pool,
    `SELECT COUNT(*)::text AS c FROM job_wallets jw
     WHERE jw.status = 'pending'
       AND jw.next_attempt_at IS NOT NULL
       AND jw.next_attempt_at > NOW()`,
  );
  const pendingBackoffFuture = Number(backoffRows[0]?.c ?? 0);

  const capRows = await pgQuery<{ c: string }>(
    pool,
    `SELECT COUNT(*)::text AS c FROM job_wallets jw
     WHERE jw.status = 'pending' AND jw.retry_count >= ?`,
    [maxAttempts],
  );
  const pendingRetryCap = Number(capRows[0]?.c ?? 0);

  const sampleRows = await pgQuery<Record<string, unknown>>(
    pool,
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
    paused: Boolean(r.paused) ? 1 : 0,
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
  const pool = await getPostgresPool();
  const rows = await pgQuery<{ id: string }>(
    pool,
    `SELECT DISTINCT j.id FROM jobs j
     INNER JOIN job_wallets jw ON jw.job_id = j.id
     WHERE j.status = 'draft' AND jw.status = 'pending'`,
  );
  return rows.map((r) => String(r.id));
}

/** Reset stale processing rows, optionally promote orphan drafts that have pending wallets. */
export async function adminRecoverStalledQueue(options?: { promoteDrafts?: boolean }): Promise<{
  staleProcessingReset: number;
  draftJobsPromoted: number;
}> {
  const promoteDrafts = options?.promoteDrafts !== false;
  const staleProcessingReset = await reconcileStaleProcessingRows();
  await reconcileAllJobStatusesFromWallets().catch(() => {});
  let draftJobsPromoted = 0;
  if (promoteDrafts) {
    const ids = await adminListDraftJobIdsWithPendingWallets();
    for (const id of ids) {
      if (await adminPromoteDraftToQueued(id)) draftJobsPromoted++;
    }
  }
  return { staleProcessingReset, draftJobsPromoted };
}
