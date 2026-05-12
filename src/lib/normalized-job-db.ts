import type { RowDataPacket } from "mysql2";
import type { ResultSetHeader } from "mysql2";
import { getMysqlPool } from "./mysql";
import { refreshJobAggregates } from "./queue/job-queue-repo";

/** Same semantics as `HistoryStatusFilter` in job-service (avoid circular imports). */
export type NormalizedHistoryFilter = "all" | "running" | "paused" | "stopped" | "completed";

function historyWhereClause(filter: NormalizedHistoryFilter): string {
  switch (filter) {
    case "running":
      return `j.status IN ('queued', 'running')`;
    case "paused":
      return `j.status = 'paused'`;
    case "stopped":
      return `j.status IN ('failed', 'cancelled')`;
    case "completed":
      return `j.status = 'completed'`;
    default:
      return "1=1";
  }
}

export type NormalizedJobListRow = RowDataPacket & {
  id: string;
  owner: string;
  status: string;
  mode: string;
  token_address: string | null;
  chain_id: number | null;
  paused: number | boolean;
  scheduled_at: Date | null;
  queued_at: Date | null;
  created_at: Date;
  updated_at: Date;
  target_run_count: number | null;
  current_run: number | null;
  loop_forever?: number | boolean;
  signer_address: string | null;
  signer_addresses_json: unknown;
  total_wallets: number;
  processed_wallets: number;
  failed_wallets: number;
  name: string | null;
  pending_wallets?: number;
  processing_wallets?: number;
  active_workers?: number;
};

function listSelectExtras(): string {
  return `,
    (SELECT COUNT(*) FROM job_wallets jw WHERE jw.job_id = j.id AND jw.status = 'pending') AS pending_wallets,
    (SELECT COUNT(*) FROM job_wallets jw WHERE jw.job_id = j.id AND jw.status = 'processing') AS processing_wallets,
    (SELECT COUNT(DISTINCT assigned_worker) FROM job_wallets jw WHERE jw.job_id = j.id AND jw.status = 'processing' AND assigned_worker IS NOT NULL AND assigned_worker <> '') AS active_workers`;
}

export async function countNormalizedJobsForOwner(
  ownerLower: string,
  statusFilter: NormalizedHistoryFilter,
): Promise<number> {
  const pool = await getMysqlPool();
  const where = historyWhereClause(statusFilter);
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT COUNT(*) AS c FROM jobs j WHERE j.owner = ? AND ${where}`,
    [ownerLower],
  );
  return Number((rows[0] as { c: number }).c ?? 0);
}

export async function listNormalizedJobsPage(
  ownerLower: string,
  offset: number,
  limit: number,
  statusFilter: NormalizedHistoryFilter,
): Promise<NormalizedJobListRow[]> {
  const pool = await getMysqlPool();
  const where = historyWhereClause(statusFilter);
  const [rows] = await pool.execute<NormalizedJobListRow[]>(
    `SELECT j.* ${listSelectExtras()}
     FROM jobs j
     WHERE j.owner = ? AND ${where}
     ORDER BY j.created_at DESC, j.id DESC
     LIMIT ? OFFSET ?`,
    [ownerLower, limit, offset],
  );
  return rows;
}

export async function listNormalizedActiveJobs(ownerLower: string, limit: number): Promise<NormalizedJobListRow[]> {
  const pool = await getMysqlPool();
  const [rows] = await pool.execute<NormalizedJobListRow[]>(
    `SELECT j.* ${listSelectExtras()}
     FROM jobs j
     WHERE j.owner = ?
       AND j.status NOT IN ('completed', 'failed', 'cancelled')
     ORDER BY j.created_at DESC, j.id DESC
     LIMIT ?`,
    [ownerLower, limit],
  );
  return rows;
}

/** Queue position among owner's queued jobs (same ordering as legacy global queue but scoped consistently). */
export async function getNormalizedQueuePositionsForJobIds(
  jobIds: string[],
  nowIso: string,
): Promise<Map<string, number>> {
  if (jobIds.length === 0) return new Map();
  const pool = await getMysqlPool();
  const placeholders = jobIds.map(() => "?").join(", ");
  const now = new Date(nowIso);
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT q.id,
      1 + (
        SELECT COUNT(*)
        FROM jobs p
        WHERE p.status = 'queued'
          AND p.paused = 0
          AND (p.scheduled_at IS NULL OR p.scheduled_at <= ?)
          AND (
            COALESCE(p.queued_at, p.created_at) < COALESCE(q.queued_at, q.created_at)
            OR (
              COALESCE(p.queued_at, p.created_at) = COALESCE(q.queued_at, q.created_at)
              AND p.created_at < q.created_at
            )
            OR (
              COALESCE(p.queued_at, p.created_at) = COALESCE(q.queued_at, q.created_at)
              AND p.created_at = q.created_at
              AND p.id < q.id
            )
          )
      ) AS queue_position
     FROM jobs q
     WHERE q.id IN (${placeholders})
       AND q.status = 'queued'
       AND q.paused = 0
       AND (q.scheduled_at IS NULL OR q.scheduled_at <= ?)`,
    [now, ...jobIds, now],
  );
  const m = new Map<string, number>();
  for (const row of rows) {
    m.set(String(row.id), Number(row.queue_position));
  }
  return m;
}

export type WalletAggRow = RowDataPacket & {
  total: number;
  completed: number;
  failed: number;
  pending: number;
  processing: number;
};

export async function getWalletAggregates(jobId: string): Promise<WalletAggRow | null> {
  const pool = await getMysqlPool();
  const [rows] = await pool.execute<WalletAggRow[]>(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
       SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
       SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
       SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) AS processing
     FROM job_wallets WHERE job_id = ?`,
    [jobId],
  );
  const r = rows[0];
  if (!r) return null;
  return r;
}

export async function getNormalizedJobRow(jobId: string): Promise<NormalizedJobListRow | null> {
  const pool = await getMysqlPool();
  const [rows] = await pool.execute<NormalizedJobListRow[]>(
    `SELECT j.* ${listSelectExtras()} FROM jobs j WHERE j.id = ? LIMIT 1`,
    [jobId],
  );
  return rows[0] ?? null;
}

export type WalletPageRow = RowDataPacket & {
  id: number;
  wallet_address: string;
  amount: string;
  status: string;
  signer_address: string | null;
  tx_hash: string | null;
  rpc_url: string | null;
  retry_count: number;
  error_message: string | null;
  updated_at: Date;
};

export type ListWalletsParams = {
  jobId: string;
  limit: number;
  cursorId?: number;
  /** 0-based; when set (non-negative), cursor pagination is ignored. */
  offset?: number;
  status?: "pending" | "processing" | "completed" | "failed";
  search?: string;
  txHash?: string;
};

export async function countJobWalletsFiltered(params: {
  jobId: string;
  status?: ListWalletsParams["status"];
  search?: string;
  txHash?: string;
}): Promise<number> {
  const pool = await getMysqlPool();
  const conditions: string[] = ["job_id = ?"];
  const vals: Array<string | number> = [params.jobId];
  if (params.status) {
    conditions.push("status = ?");
    vals.push(params.status);
  }
  if (params.txHash?.trim()) {
    conditions.push("tx_hash = ?");
    vals.push(params.txHash.trim());
  }
  if (params.search?.trim()) {
    conditions.push("wallet_address LIKE ?");
    vals.push(`%${params.search.trim()}%`);
  }
  const where = conditions.join(" AND ");
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT COUNT(*) AS c FROM job_wallets WHERE ${where}`,
    vals,
  );
  return Number((rows[0] as { c: number }).c ?? 0);
}

export async function listJobWalletsPage(params: ListWalletsParams): Promise<{ rows: WalletPageRow[]; nextCursor: number | null }> {
  const pool = await getMysqlPool();
  const limit = Math.min(500, Math.max(1, params.limit));
  const conditions: string[] = ["job_id = ?"];
  const vals: Array<string | number> = [params.jobId];

  if (params.status) {
    conditions.push("status = ?");
    vals.push(params.status);
  }
  if (params.txHash?.trim()) {
    conditions.push("tx_hash = ?");
    vals.push(params.txHash.trim());
  }
  if (params.search?.trim()) {
    conditions.push("wallet_address LIKE ?");
    vals.push(`%${params.search.trim()}%`);
  }

  const useOffset = params.offset != null && Number(params.offset) >= 0;
  if (!useOffset && params.cursorId != null && params.cursorId > 0) {
    conditions.push("id > ?");
    vals.push(params.cursorId);
  }

  const where = conditions.join(" AND ");

  let rows: WalletPageRow[];
  if (useOffset) {
    const offset = Math.floor(Number(params.offset));
    vals.push(limit + 1, offset);
    const [r] = await pool.execute<WalletPageRow[]>(
      `SELECT id, wallet_address, amount, status, signer_address, tx_hash, rpc_url, retry_count, error_message, updated_at
       FROM job_wallets
       WHERE ${where}
       ORDER BY id ASC
       LIMIT ? OFFSET ?`,
      vals,
    );
    rows = r;
  } else {
    vals.push(limit + 1);
    const [r] = await pool.execute<WalletPageRow[]>(
      `SELECT id, wallet_address, amount, status, signer_address, tx_hash, rpc_url, retry_count, error_message, updated_at
       FROM job_wallets
       WHERE ${where}
       ORDER BY id ASC
       LIMIT ?`,
      vals,
    );
    rows = r;
  }

  let nextCursor: number | null = null;
  let slice = rows;
  if (rows.length > limit) {
    slice = rows.slice(0, limit);
    const last = slice[slice.length - 1];
    nextCursor = last ? Number(last.id) : null;
  }
  return { rows: slice, nextCursor };
}

export async function updateNormalizedJobMeta(
  jobId: string,
  patch: Partial<{
    status: string;
    paused: boolean;
    queuedAt: Date | null;
    scheduledAt: Date | null;
    currentRun: number;
    targetRunCount: number;
  }>,
): Promise<void> {
  const pool = await getMysqlPool();
  const sets: string[] = [];
  const vals: Array<string | number | Date | boolean | null> = [];
  if (patch.status !== undefined) {
    sets.push("status = ?");
    vals.push(patch.status);
  }
  if (patch.paused !== undefined) {
    sets.push("paused = ?");
    vals.push(patch.paused ? 1 : 0);
  }
  if (patch.queuedAt !== undefined) {
    sets.push("queued_at = ?");
    vals.push(patch.queuedAt);
  }
  if (patch.scheduledAt !== undefined) {
    sets.push("scheduled_at = ?");
    vals.push(patch.scheduledAt);
  }
  if (patch.currentRun !== undefined) {
    sets.push("current_run = ?");
    vals.push(patch.currentRun);
  }
  if (patch.targetRunCount !== undefined) {
    sets.push("target_run_count = ?");
    vals.push(patch.targetRunCount);
  }
  if (sets.length === 0) return;
  vals.push(jobId);
  await pool.execute(`UPDATE jobs SET ${sets.join(", ")}, updated_at = CURRENT_TIMESTAMP(3) WHERE id = ?`, vals);
}

/** Full rerun: reset wallet rows and queue job. */
export async function rerunNormalizedJob(jobId: string): Promise<void> {
  const pool = await getMysqlPool();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.execute(
      `UPDATE job_wallets SET
         status = 'pending',
         tx_hash = NULL,
         rpc_url = NULL,
         error_message = NULL,
         assigned_worker = NULL,
         retry_count = 0,
         updated_at = CURRENT_TIMESTAMP(3)
       WHERE job_id = ?`,
      [jobId],
    );
    await conn.execute(
      `UPDATE jobs SET
         status = 'queued',
         paused = 0,
         queued_at = CURRENT_TIMESTAMP(3),
         scheduled_at = NULL,
         current_run = 1,
         updated_at = CURRENT_TIMESTAMP(3)
       WHERE id = ?`,
      [jobId],
    );
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
  await refreshJobAggregates(jobId);
}

/**
 * After aggregates settle the job to `completed` or `failed`, automatically start another cycle when
 * `loop_forever` is set (creation-time Loop checkbox). Paused/cancelled jobs never auto-rerun.
 */
export async function maybeAutoRerunLoopJob(jobId: string): Promise<void> {
  const pool = await getMysqlPool();
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT status, paused, COALESCE(loop_forever, 0) AS lf FROM jobs WHERE id = ? LIMIT 1`,
    [jobId],
  );
  const r = rows[0] as { status?: string; paused?: number; lf?: number } | undefined;
  if (!r) return;
  if (!Number(r.lf)) return;
  if (Number(r.paused)) return;
  const st = String(r.status);
  if (st !== "completed" && st !== "failed") return;
  await rerunNormalizedJob(jobId);
}

/** Queue route: reset every wallet row that is not completed (same as legacy non-success → queued). */
export async function requeueIncompleteWallets(jobId: string): Promise<void> {
  const pool = await getMysqlPool();
  await pool.execute(
    `UPDATE job_wallets SET
       status = 'pending',
       assigned_worker = NULL,
       updated_at = CURRENT_TIMESTAMP(3)
     WHERE job_id = ? AND status <> 'completed'`,
    [jobId],
  );
  await refreshJobAggregates(jobId);
}

export async function retryFailedWalletsOnly(jobId: string): Promise<number> {
  const pool = await getMysqlPool();
  const [res] = await pool.execute<ResultSetHeader>(
    `UPDATE job_wallets SET
       status = 'pending',
       retry_count = 0,
       error_message = NULL,
       tx_hash = NULL,
       rpc_url = NULL,
       assigned_worker = NULL,
       updated_at = CURRENT_TIMESTAMP(3)
     WHERE job_id = ? AND status = 'failed'`,
    [jobId],
  );
  await refreshJobAggregates(jobId);
  return res.affectedRows ?? 0;
}

export async function cancelNormalizedJob(jobId: string): Promise<void> {
  const pool = await getMysqlPool();
  await pool.execute(
    `UPDATE jobs SET status = 'cancelled', paused = 1, updated_at = CURRENT_TIMESTAMP(3) WHERE id = ?`,
    [jobId],
  );
}
