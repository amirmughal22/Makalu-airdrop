/**
 * Migrates legacy `airdrop_jobs.resultsJson` recipient arrays into normalized `jobs` + `job_wallets`.
 * Safe per-job transactions; chunked INSERTs (default 1000) inside each transaction.
 */
import type { PoolClient } from "pg";
import type { BatchResult } from "../job-types";
import { getPostgresPool, pgExecute, pgQuery, type JobRow } from "../postgres";
import { refreshJobAggregates } from "../queue/job-queue-repo";

export type MigrateLegacyJobsOptions = {
  /** Log actions only; no writes. */
  dryRun?: boolean;
  /** Max legacy jobs to process in this run. */
  limit?: number;
  /** Process only this job id. */
  jobId?: string | null;
  /** Rows per INSERT batch inside the transaction (default 1000). */
  chunkSize?: number;
};

export type MigrateLegacyJobsReport = {
  jobsSucceeded: number;
  jobsSkipped: number;
  walletsInserted: number;
  failures: Array<{ jobId: string; error: string }>;
  durationMs: number;
};

function envInt(name: string, fallback: number, min: number, max: number): number {
  const n = parseInt(process.env[name]?.trim() ?? "", 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function migrateLegacyChunkSizeFromEnv(): number {
  return envInt("MIGRATE_LEGACY_CHUNK", 1000, 50, 10_000);
}

function parseSignerList(raw: unknown): string[] {
  if (raw == null) return [];
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter((x): x is string => typeof x === "string").map((x) => x.toLowerCase()))];
  } catch {
    return [];
  }
}

function jsonBufferToString(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (raw != null && typeof Buffer !== "undefined" && Buffer.isBuffer(raw)) return raw.toString("utf8");
  return "";
}

/** Parse `resultsJson` from TEXT / JSON / Buffer / object. */
export function parseLegacyResultsJson(raw: unknown): BatchResult[] {
  if (raw == null) return [];
  if (Array.isArray(raw)) return normalizeResultsArray(raw as unknown[]);
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(raw)) {
    try {
      const parsed = JSON.parse(raw.toString("utf8")) as unknown;
      return Array.isArray(parsed) ? normalizeResultsArray(parsed) : [];
    } catch {
      return [];
    }
  }
  const text = jsonBufferToString(raw);
  if (!text.trim()) return [];
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!Array.isArray(parsed)) return [];
    return normalizeResultsArray(parsed);
  } catch {
    return [];
  }
}

function normalizeResultsArray(items: unknown[]): BatchResult[] {
  const out: BatchResult[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const recipient =
      typeof o.recipient === "string"
        ? o.recipient
        : typeof o.address === "string"
          ? o.address
          : typeof o.wallet === "string"
            ? o.wallet
            : "";
    const amount = typeof o.amount === "string" ? o.amount : String(o.amount ?? "0");
    const statusRaw = typeof o.status === "string" ? o.status : "queued";
    const txHash = typeof o.txHash === "string" ? o.txHash : undefined;
    const error = typeof o.error === "string" ? o.error : undefined;
    const signerAddress = typeof o.signerAddress === "string" ? o.signerAddress : undefined;
    const rpcUrl = typeof o.rpcUrl === "string" ? o.rpcUrl : undefined;
    if (!recipient.trim()) continue;
    out.push({
      recipient: recipient.trim(),
      amount,
      status: statusRaw as BatchResult["status"],
      txHash,
      error,
      signerAddress,
      rpcUrl,
    });
  }
  return out;
}

function walletRowStatus(batchStatus: string): "pending" | "completed" | "failed" {
  const s = batchStatus.toLowerCase();
  if (s === "success") return "completed";
  if (s === "failed") return "failed";
  return "pending";
}

function expectCountsFromParsed(parsed: BatchResult[]): {
  total: number;
  completed: number;
  failed: number;
  pending: number;
} {
  let completed = 0;
  let failed = 0;
  let pending = 0;
  for (const r of parsed) {
    const w = walletRowStatus(String(r.status));
    if (w === "completed") completed++;
    else if (w === "failed") failed++;
    else pending++;
  }
  return { total: parsed.length, completed, failed, pending };
}

async function validateMigration(pool: Awaited<ReturnType<typeof getPostgresPool>>, jobId: string, expected: ReturnType<typeof expectCountsFromParsed>): Promise<void> {
  const rows = await pgQuery<{
    total?: unknown;
    completed?: unknown;
    failed?: unknown;
    pendingish?: unknown;
  }>(
    pool,
    `SELECT
       COUNT(*) AS total,
       COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) AS completed,
       COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
       COALESCE(SUM(CASE WHEN status IN ('pending', 'processing') THEN 1 ELSE 0 END), 0) AS pendingish
     FROM job_wallets WHERE job_id = ?`,
    [jobId],
  );
  const r = rows[0];
  const total = Number(r?.total ?? 0);
  const completed = Number(r?.completed ?? 0);
  const failed = Number(r?.failed ?? 0);
  const pendingish = Number(r?.pendingish ?? 0);

  if (total !== expected.total) {
    throw new Error(`validation: total mismatch DB=${total} expected=${expected.total}`);
  }
  if (completed !== expected.completed) {
    throw new Error(`validation: completed mismatch DB=${completed} expected=${expected.completed}`);
  }
  if (failed !== expected.failed) {
    throw new Error(`validation: failed mismatch DB=${failed} expected=${expected.failed}`);
  }
  if (pendingish !== expected.pending) {
    throw new Error(`validation: pending mismatch DB=${pendingish} expected=${expected.pending}`);
  }
}

function buildWalletRows(
  legacy: JobRow,
  parsed: BatchResult[],
): Array<{
  wallet_address: string;
  amount: string;
  status: "pending" | "completed" | "failed";
  signer_address: string;
  tx_hash: string | null;
  rpc_url: string | null;
  retry_count: number;
  error_message: string | null;
}> {
  let distributors = parseSignerList(legacy.signerAddressesJson);
  if (distributors.length === 0 && legacy.signerAddress) {
    distributors = [String(legacy.signerAddress).toLowerCase()];
  }
  if (distributors.length === 0) {
    distributors = [String(legacy.owner).toLowerCase()];
  }

  const walletRows: Array<{
    wallet_address: string;
    amount: string;
    status: "pending" | "completed" | "failed";
    signer_address: string;
    tx_hash: string | null;
    rpc_url: string | null;
    retry_count: number;
    error_message: string | null;
  }> = [];

  for (let i = 0; i < parsed.length; i++) {
    const r = parsed[i]!;
    const signer = (r.signerAddress?.trim().toLowerCase() || distributors[i % distributors.length])!;
    walletRows.push({
      wallet_address: r.recipient.trim(),
      amount: String(r.amount ?? "0"),
      status: walletRowStatus(String(r.status)),
      signer_address: signer,
      tx_hash: r.txHash ? r.txHash.slice(0, 128) : null,
      rpc_url: r.rpcUrl ? r.rpcUrl.slice(0, 512) : null,
      retry_count: 0,
      error_message: r.error ? r.error.slice(0, 8000) : null,
    });
  }
  return walletRows;
}

/** Locks legacy row, replaces normalized `jobs`/`job_wallets`, sets `migrated_to_queue`. Returns null if skipped. */
async function migrateOneLegacyJobMutating(
  conn: PoolClient,
  jobId: string,
  chunkSize: number,
): Promise<{ jobId: string; walletCount: number; expected: ReturnType<typeof expectCountsFromParsed> } | null> {
  await conn.query("BEGIN");
  try {
    const locked = await pgQuery<JobRow>(conn, `SELECT * FROM airdrop_jobs WHERE id = ? FOR UPDATE`, [jobId]);
    const legacy = locked[0];
    if (!legacy) {
      await conn.query("ROLLBACK");
      return null;
    }
    if (Boolean(legacy.migrated_to_queue)) {
      await conn.query("ROLLBACK");
      return null;
    }

    const parsed = parseLegacyResultsJson(legacy.resultsJson);
    if (parsed.length === 0) {
      await conn.query("ROLLBACK");
      console.warn(`[migrate] skip ${jobId}: empty resultsJson`);
      return null;
    }
    const walletRows = buildWalletRows(legacy, parsed);
    const expected = expectCountsFromParsed(parsed);

    await pgExecute(conn, `DELETE FROM jobs WHERE id = ?`, [jobId]);

    const chainId =
      legacy.chainId != null && Number(legacy.chainId) > 0 ? Number(legacy.chainId) : null;
    const targetRun = Math.max(1, Number(legacy.targetRunCount ?? 1));
    const currentRun = Math.max(1, Number(legacy.currentRun ?? 1));
    const distributors = parseSignerList(legacy.signerAddressesJson);
    const distResolved =
      distributors.length > 0
        ? distributors
        : legacy.signerAddress
          ? [String(legacy.signerAddress).toLowerCase()]
          : [String(legacy.owner).toLowerCase()];
    const signersJson = JSON.stringify(distResolved);
    const firstSigner = distResolved[0] ?? String(legacy.owner).toLowerCase();

    await pgExecute(
      conn,
      `INSERT INTO jobs (
        id, owner, name, status, total_wallets, processed_wallets, failed_wallets,
        mode, token_address, chain_id, paused, scheduled_at, queued_at,
        target_run_count, current_run, signer_address, signer_addresses_json,
        created_at, updated_at
      ) VALUES (?, ?, NULL, ?, 0, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, NOW())`,
      [
        jobId,
        String(legacy.owner).toLowerCase(),
        String(legacy.status),
        String(legacy.mode),
        legacy.tokenAddress ? String(legacy.tokenAddress) : null,
        chainId,
        Boolean(legacy.paused),
        legacy.scheduledAt ? new Date(legacy.scheduledAt) : null,
        legacy.queuedAt ? new Date(legacy.queuedAt) : null,
        targetRun,
        currentRun,
        legacy.signerAddress ? String(legacy.signerAddress) : firstSigner,
        signersJson,
        new Date(legacy.createdAt),
      ],
    );

    for (let i = 0; i < walletRows.length; i += chunkSize) {
      const slice = walletRows.slice(i, i + chunkSize);
      const placeholders = slice.map(() => "(?,?,?,?,?,?,?,?,?)").join(", ");
      const flat: Array<string | number | null> = [];
      for (const w of slice) {
        flat.push(
          jobId,
          w.wallet_address,
          w.amount,
          w.status,
          w.signer_address,
          w.tx_hash,
          w.rpc_url,
          w.retry_count,
          w.error_message,
        );
      }
      await pgExecute(
        conn,
        `INSERT INTO job_wallets (
          job_id, wallet_address, amount, status, signer_address, tx_hash, rpc_url, retry_count, error_message
        ) VALUES ${placeholders}`,
        flat,
      );
    }

    await pgExecute(conn, `UPDATE airdrop_jobs SET migrated_to_queue = TRUE WHERE id = ?`, [jobId]);

    await conn.query("COMMIT");
    return { jobId, walletCount: walletRows.length, expected };
  } catch (e) {
    await conn.query("ROLLBACK");
    throw e;
  }
}

/** Migrate legacy JSON-backed jobs into `jobs` / `job_wallets`. Idempotent per job via `migrated_to_queue`. */
export async function migrateLegacyJobsToQueue(options: MigrateLegacyJobsOptions = {}): Promise<MigrateLegacyJobsReport> {
  const dryRun = Boolean(options.dryRun);
  const limit = Math.max(1, options.limit ?? 10_000);
  const jobIdFilter = options.jobId?.trim() || null;
  const chunkSize = options.chunkSize ?? migrateLegacyChunkSizeFromEnv();

  const started = Date.now();
  const failures: Array<{ jobId: string; error: string }> = [];
  let jobsSucceeded = 0;
  let jobsSkipped = 0;
  let walletsInserted = 0;

  const pool = await getPostgresPool();

  let sql = `SELECT id FROM airdrop_jobs WHERE COALESCE(migrated_to_queue, FALSE) = FALSE`;
  const params: Array<string | number> = [];
  if (jobIdFilter) {
    sql += ` AND id = ?`;
    params.push(jobIdFilter);
  }
  sql += ` ORDER BY "createdAt" ASC LIMIT ?`;
  params.push(limit);

  const idRows = await pgQuery<{ id: string }>(pool, sql, params);
  const ids = idRows.map((r) => String(r.id));

  console.log(`[migrate] candidates: ${ids.length} legacy job(s)${dryRun ? " (dry-run)" : ""}`);

  for (const id of ids) {
    try {
      if (dryRun) {
        const legacyRows = await pgQuery<JobRow>(pool, `SELECT * FROM airdrop_jobs WHERE id = ?`, [id]);
        const legacy = legacyRows[0];
        if (!legacy || Boolean(legacy.migrated_to_queue)) {
          jobsSkipped++;
          continue;
        }
        const parsed = parseLegacyResultsJson(legacy.resultsJson);
        if (parsed.length === 0) {
          console.warn(`[migrate] skip ${id}: empty resultsJson`);
          jobsSkipped++;
          continue;
        }
        const expected = expectCountsFromParsed(parsed);
        console.log(
          `[migrate] dry-run ${id}: ${parsed.length} wallets (${expected.completed} completed, ${expected.failed} failed, ${expected.pending} pending)`,
        );
        walletsInserted += parsed.length;
        jobsSucceeded++;
        continue;
      }

      const conn = await pool.connect();
      try {
        const result = await migrateOneLegacyJobMutating(conn, id, chunkSize);
        if (!result) {
          jobsSkipped++;
          continue;
        }
        await refreshJobAggregates(result.jobId);
        await validateMigration(pool, result.jobId, result.expected);

        walletsInserted += result.walletCount;
        jobsSucceeded++;
        console.log(`[migrate] ok ${result.jobId}: ${result.walletCount} wallet row(s)`);
      } finally {
        conn.release();
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      failures.push({ jobId: id, error: msg });
      console.error(`[migrate] FAILED ${id}:`, msg);
    }
  }

  const durationMs = Date.now() - started;
  console.log(
    `[migrate] done in ${durationMs}ms — jobs ok: ${jobsSucceeded}, skipped: ${jobsSkipped}, wallets: ${walletsInserted}, failures: ${failures.length}`,
  );

  return {
    jobsSucceeded,
    jobsSkipped,
    walletsInserted,
    failures,
    durationMs,
  };
}
