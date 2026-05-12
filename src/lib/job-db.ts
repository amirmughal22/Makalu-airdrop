import type { ResultSetHeader, RowDataPacket } from "mysql2";
import { MAX_JOB_TARGET_RUNS, type BatchResult, type StoredJob } from "./job-types";
import type { BatchResultSummary } from "./job-summary";
import { getMysqlPool, type JobRow } from "./mysql";
import type { HistoryStatusFilter } from "./job-service";

function parseSignerAddressesJson(rawSigners: unknown): string[] | undefined {
  if (rawSigners == null) return undefined;
  try {
    const parsed = typeof rawSigners === "string" ? JSON.parse(rawSigners) : rawSigners;
    if (Array.isArray(parsed)) {
      const signerAddresses = parsed.filter((x): x is string => typeof x === "string").map((x) => x.toLowerCase());
      if (signerAddresses.length === 0) return undefined;
      return signerAddresses;
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

function statusWhereSql(filter: HistoryStatusFilter): { clause: string; params: string[] } {
  if (filter === "running") return { clause: "status IN (?, ?)", params: ["running", "queued"] };
  if (filter === "paused") return { clause: "status = ?", params: ["paused"] };
  if (filter === "stopped") return { clause: "status IN (?, ?)", params: ["failed", "cancelled"] };
  if (filter === "completed") return { clause: "status = ?", params: ["completed"] };
  return { clause: "1=1", params: [] };
}

function rowToJob(row: JobRow): StoredJob {
  const raw = row.resultsJson;
  const results =
    typeof raw === "string" ? (JSON.parse(raw) as BatchResult[]) : (raw as BatchResult[]);
  const signerAddresses = parseSignerAddressesJson((row as JobRow).signerAddressesJson);

  return {
    jobId: row.id,
    owner: row.owner,
    signerAddress: (row as JobRow & { signerAddress?: string | null }).signerAddress ?? undefined,
    signerAddresses,
    status: row.status as StoredJob["status"],
    mode: row.mode as StoredJob["mode"],
    tokenAddress: row.tokenAddress ?? undefined,
    chainId: row.chainId != null && row.chainId > 0 ? Number(row.chainId) : undefined,
    scheduledAt: row.scheduledAt ? new Date(row.scheduledAt).toISOString() : undefined,
    queuedAt: row.queuedAt ? new Date(row.queuedAt).toISOString() : undefined,
    createdAt: new Date(row.createdAt).toISOString(),
    paused: Boolean(row.paused),
    targetRunCount: row.targetRunCount != null ? Number(row.targetRunCount) : 1,
    currentRun: row.currentRun != null ? Number(row.currentRun) : 1,
    results: Array.isArray(results) ? results : [],
    _runnerActive: false,
    migratedToQueue: Boolean((row as JobRow).migrated_to_queue),
  };
}

export async function getJobFromDb(jobId: string): Promise<StoredJob | undefined> {
  const pool = await getMysqlPool();
  const [rows] = await pool.execute<JobRow[]>("SELECT * FROM airdrop_jobs WHERE id = ?", [jobId]);
  const row = rows[0];
  if (!row) return undefined;
  return rowToJob(row);
}

export async function claimQueuedDueJobFromDb(jobId: string, nowIso: string): Promise<StoredJob | undefined> {
  const pool = await getMysqlPool();
  const [result] = await pool.execute<ResultSetHeader>(
    `UPDATE airdrop_jobs
     SET status = 'running', paused = 0
     WHERE id = ?
       AND status = 'queued'
       AND paused = 0
       AND COALESCE(migrated_to_queue, 0) = 0
       AND (scheduledAt IS NULL OR scheduledAt <= ?)
     LIMIT 1`,
    [jobId, new Date(nowIso)],
  );
  if (result.affectedRows !== 1) return undefined;
  return getJobFromDb(jobId);
}

export async function saveJobToDb(job: StoredJob): Promise<void> {
  const { _runnerActive: _r, ...persistable } = job;
  void _r;
  const pool = await getMysqlPool();
  const json = JSON.stringify(persistable.results);
  const signersJson =
    persistable.signerAddresses && persistable.signerAddresses.length > 0
      ? JSON.stringify(persistable.signerAddresses)
      : null;

  const tRun = Math.max(1, Math.min(MAX_JOB_TARGET_RUNS, persistable.targetRunCount ?? 1));
  const cRun = Math.max(1, Math.min(MAX_JOB_TARGET_RUNS, persistable.currentRun ?? 1));

  await pool.execute(
    `INSERT INTO airdrop_jobs (id, owner, signerAddress, signerAddressesJson, status, mode, tokenAddress, chainId, scheduledAt, queuedAt, paused, resultsJson, targetRunCount, currentRun)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       owner = VALUES(owner),
      signerAddress = VALUES(signerAddress),
      signerAddressesJson = VALUES(signerAddressesJson),
       status = VALUES(status),
       mode = VALUES(mode),
       tokenAddress = VALUES(tokenAddress),
       chainId = VALUES(chainId),
      scheduledAt = VALUES(scheduledAt),
      queuedAt = VALUES(queuedAt),
       paused = VALUES(paused),
       resultsJson = VALUES(resultsJson),
      targetRunCount = VALUES(targetRunCount),
      currentRun = VALUES(currentRun)`,
    [
      job.jobId,
      persistable.owner,
      persistable.signerAddress ?? null,
      signersJson,
      persistable.status,
      persistable.mode,
      persistable.tokenAddress ?? null,
      persistable.chainId ?? null,
      persistable.scheduledAt ? new Date(persistable.scheduledAt) : null,
      persistable.queuedAt ? new Date(persistable.queuedAt) : null,
      persistable.paused ? 1 : 0,
      json,
      tRun,
      cRun,
    ],
  );
}

export async function listJobsFromDbPage(
  ownerLower: string,
  offset: number,
  limit: number,
  statusFilter: HistoryStatusFilter = "all",
): Promise<{ items: StoredJob[]; total: number }> {
  const pool = await getMysqlPool();
  const whereStatus = statusWhereSql(statusFilter);
  const where = `owner = ? AND ${whereStatus.clause}`;
  const [cntRows] = await pool.execute<RowDataPacket[]>(
    `SELECT COUNT(*) AS cnt FROM airdrop_jobs WHERE ${where}`,
    [ownerLower, ...whereStatus.params],
  );
  const total = Number((cntRows[0] as { cnt: number }).cnt ?? 0);
  const [rows] = await pool.execute<JobRow[]>(
    `SELECT * FROM airdrop_jobs WHERE ${where} ORDER BY createdAt DESC, id DESC LIMIT ? OFFSET ?`,
    [ownerLower, ...whereStatus.params, limit, offset],
  );
  return { items: rows.map(rowToJob), total };
}

export async function listActiveJobsFromDb(ownerLower: string, limit: number): Promise<StoredJob[]> {
  const pool = await getMysqlPool();
  const [rows] = await pool.execute<JobRow[]>(
    `SELECT * FROM airdrop_jobs
     WHERE owner = ? AND status NOT IN ('completed', 'failed', 'cancelled')
     ORDER BY createdAt DESC, id DESC
     LIMIT ?`,
    [ownerLower, Math.max(1, limit)],
  );
  return rows.map(rowToJob);
}

export async function listQueuedDueJobsFromDb(limit: number, nowIso: string): Promise<StoredJob[]> {
  const pool = await getMysqlPool();
  const [rows] = await pool.execute<JobRow[]>(
    `SELECT * FROM airdrop_jobs
     WHERE status = 'queued' AND paused = 0 AND COALESCE(migrated_to_queue, 0) = 0
       AND (scheduledAt IS NULL OR scheduledAt <= ?)
     ORDER BY COALESCE(queuedAt, createdAt) ASC, createdAt ASC, id ASC
     LIMIT ?`,
    [new Date(nowIso), Math.max(1, limit)],
  );
  return rows.map(rowToJob);
}

/** Global queue order (same as the worker). IDs only — no `resultsJson`. */
export async function listQueuedDueJobIdsFromDb(limit: number, nowIso: string): Promise<string[]> {
  const pool = await getMysqlPool();
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT id FROM airdrop_jobs
     WHERE status = 'queued' AND paused = 0 AND COALESCE(migrated_to_queue, 0) = 0
       AND (scheduledAt IS NULL OR scheduledAt <= ?)
     ORDER BY COALESCE(queuedAt, createdAt) ASC, createdAt ASC, id ASC
     LIMIT ?`,
    [new Date(nowIso), Math.max(1, limit)],
  );
  return rows.map((r) => String(r.id));
}

/** 1-based position in the global queue for the given job ids (only requested ids appear in the map). */
export async function getQueuePositionsForJobIdsFromDb(jobIds: string[], nowIso: string): Promise<Map<string, number>> {
  const need = new Set(jobIds);
  if (need.size === 0) return new Map();

  const pool = await getMysqlPool();
  const ids = [...need];
  const placeholders = ids.map(() => "?").join(", ");
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT q.id,
            1 + (
              SELECT COUNT(*)
              FROM airdrop_jobs p
              WHERE p.status = 'queued'
                AND p.paused = 0
                AND COALESCE(p.migrated_to_queue, 0) = 0
                AND (p.scheduledAt IS NULL OR p.scheduledAt <= ?)
                AND (
                  COALESCE(p.queuedAt, p.createdAt) < COALESCE(q.queuedAt, q.createdAt)
                  OR (
                    COALESCE(p.queuedAt, p.createdAt) = COALESCE(q.queuedAt, q.createdAt)
                    AND p.createdAt < q.createdAt
                  )
                  OR (
                    COALESCE(p.queuedAt, p.createdAt) = COALESCE(q.queuedAt, q.createdAt)
                    AND p.createdAt = q.createdAt
                    AND p.id < q.id
                  )
                )
            ) AS queuePosition
     FROM airdrop_jobs q
     WHERE q.id IN (${placeholders})
       AND q.status = 'queued'
       AND q.paused = 0
       AND COALESCE(q.migrated_to_queue, 0) = 0
       AND (q.scheduledAt IS NULL OR q.scheduledAt <= ?)`,
    [new Date(nowIso), ...ids, new Date(nowIso)],
  );

  const m = new Map<string, number>();
  for (const row of rows) {
    m.set(String(row.id), Number(row.queuePosition));
  }
  return m;
}

export async function listRunningJobsFromDb(limit: number): Promise<StoredJob[]> {
  const pool = await getMysqlPool();
  const [rows] = await pool.execute<JobRow[]>(
    `SELECT * FROM airdrop_jobs
     WHERE status = 'running'
     ORDER BY updatedAt DESC, createdAt DESC
     LIMIT ?`,
    [Math.max(1, limit)],
  );
  return rows.map(rowToJob);
}

export async function listStaleRunningJobsFromDb(limit: number, staleBeforeIso: string): Promise<StoredJob[]> {
  const pool = await getMysqlPool();
  const [rows] = await pool.execute<JobRow[]>(
    `SELECT * FROM airdrop_jobs
     WHERE status = 'running' AND updatedAt <= ?
       AND COALESCE(migrated_to_queue, 0) = 0
     ORDER BY updatedAt ASC, createdAt ASC
     LIMIT ?`,
    [new Date(staleBeforeIso), Math.max(1, limit)],
  );
  return rows.map(rowToJob);
}

function storedJobShellFromDbRow(row: JobRow): StoredJob {
  const signerAddresses = parseSignerAddressesJson(row.signerAddressesJson);
  return {
    jobId: row.id,
    owner: row.owner,
    signerAddress: row.signerAddress ?? undefined,
    signerAddresses,
    status: row.status as StoredJob["status"],
    mode: row.mode as StoredJob["mode"],
    tokenAddress: row.tokenAddress ?? undefined,
    chainId: row.chainId != null && row.chainId > 0 ? Number(row.chainId) : undefined,
    scheduledAt: row.scheduledAt ? new Date(row.scheduledAt).toISOString() : undefined,
    queuedAt: row.queuedAt ? new Date(row.queuedAt).toISOString() : undefined,
    createdAt: new Date(row.createdAt).toISOString(),
    paused: Boolean(row.paused),
    targetRunCount: row.targetRunCount != null ? Number(row.targetRunCount) : 1,
    currentRun: row.currentRun != null ? Number(row.currentRun) : 1,
    results: [],
    _runnerActive: false,
    migratedToQueue: Boolean((row as JobRow).migrated_to_queue),
  };
}

function resultSummaryFromAggColumns(row: RowDataPacket): BatchResultSummary {
  const r = row as RowDataPacket & {
    sum_total?: unknown;
    sum_success?: unknown;
    sum_failed?: unknown;
    sum_pending?: unknown;
    sum_queued?: unknown;
    sum_submitted?: unknown;
  };
  return {
    total: Number(r.sum_total) || 0,
    success: Number(r.sum_success) || 0,
    failed: Number(r.sum_failed) || 0,
    pending: Number(r.sum_pending) || 0,
    queued: Number(r.sum_queued) || 0,
    submitted: Number(r.sum_submitted) || 0,
  };
}

const aggregateSubquerySql = `
  SELECT
    j2.id,
    COALESCE(JSON_LENGTH(j2.resultsJson), 0) AS sum_total,
    COALESCE(SUM(CASE WHEN jt.status = 'success' THEN 1 ELSE 0 END), 0) AS sum_success,
    COALESCE(SUM(CASE WHEN jt.status = 'failed' THEN 1 ELSE 0 END), 0) AS sum_failed,
    COALESCE(SUM(CASE WHEN jt.status = 'pending' THEN 1 ELSE 0 END), 0) AS sum_pending,
    COALESCE(SUM(CASE WHEN jt.status = 'queued' THEN 1 ELSE 0 END), 0) AS sum_queued,
    COALESCE(SUM(CASE WHEN jt.status = 'submitted' THEN 1 ELSE 0 END), 0) AS sum_submitted
  FROM airdrop_jobs j2
  LEFT JOIN JSON_TABLE(COALESCE(j2.resultsJson, JSON_ARRAY()), '$[*]' COLUMNS (
    status VARCHAR(32) PATH '$.status'
  )) AS jt ON TRUE`;

/** Single job row for polling (`GET ?summary=1`) without transferring full `resultsJson` to the app. Requires MySQL 8+ / MariaDB 10.6+ `JSON_TABLE`. */
export async function getJobSummarySnapshotFromDb(
  jobId: string,
): Promise<{ job: StoredJob; resultSummary: BatchResultSummary } | undefined> {
  const pool = await getMysqlPool();
  const jobCols = `j.id, j.owner, j.signerAddress, j.signerAddressesJson, j.status, j.mode, j.tokenAddress, j.chainId,
      j.scheduledAt, j.queuedAt, j.paused, j.createdAt, j.targetRunCount, j.currentRun`;
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT ${jobCols}, agg.sum_total, agg.sum_success, agg.sum_failed, agg.sum_pending, agg.sum_queued, agg.sum_submitted
     FROM airdrop_jobs j
     INNER JOIN (${aggregateSubquerySql}
     WHERE j2.id = ?
     GROUP BY j2.id) agg ON j.id = agg.id
     WHERE j.id = ?
     LIMIT 1`,
    [jobId, jobId],
  );
  const row = rows[0];
  if (!row) return undefined;
  const job = storedJobShellFromDbRow(row as unknown as JobRow);
  return { job, resultSummary: resultSummaryFromAggColumns(row) };
}

/** Active jobs list with summary stats — aggregates only the rows returned (bounded by `limit`), not every non-terminal job for the owner. */
export async function listActiveJobsSummarySnapshotsFromDb(
  ownerLower: string,
  limit: number,
): Promise<Array<{ job: StoredJob; resultSummary: BatchResultSummary }>> {
  const pool = await getMysqlPool();
  const lim = Math.max(1, limit);
  const jobCols = `j.id, j.owner, j.signerAddress, j.signerAddressesJson, j.status, j.mode, j.tokenAddress, j.chainId,
      j.scheduledAt, j.queuedAt, j.paused, j.createdAt, j.targetRunCount, j.currentRun`;
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT ${jobCols}, agg.sum_total, agg.sum_success, agg.sum_failed, agg.sum_pending, agg.sum_queued, agg.sum_submitted
     FROM airdrop_jobs j
     INNER JOIN (${aggregateSubquerySql}
     WHERE j2.id IN (
       SELECT id FROM (
         SELECT id FROM airdrop_jobs
         WHERE owner = ?
           AND status NOT IN ('completed', 'failed', 'cancelled')
         ORDER BY createdAt DESC, id DESC
         LIMIT ?
       ) lim_ids
     )
     GROUP BY j2.id) agg ON j.id = agg.id
     WHERE j.owner = ?
       AND j.status NOT IN ('completed', 'failed', 'cancelled')
     ORDER BY j.createdAt DESC, j.id DESC
     LIMIT ?`,
    [ownerLower, lim, ownerLower, lim],
  );
  return rows.map((row) => ({
    job: storedJobShellFromDbRow(row as unknown as JobRow),
    resultSummary: resultSummaryFromAggColumns(row),
  }));
}

/** Paginated jobs history with aggregate stats — avoids loading full `resultsJson` per row when supported. */
export async function listJobsSummarySnapshotsFromDbPage(
  ownerLower: string,
  offset: number,
  limit: number,
  statusFilter: HistoryStatusFilter = "all",
): Promise<{ items: Array<{ job: StoredJob; resultSummary: BatchResultSummary }>; total: number }> {
  const pool = await getMysqlPool();
  const whereStatus = statusWhereSql(statusFilter);
  const where = `owner = ? AND ${whereStatus.clause}`;
  const baseParams = [ownerLower, ...whereStatus.params];
  const [cntRows] = await pool.execute<RowDataPacket[]>(
    `SELECT COUNT(*) AS cnt FROM airdrop_jobs WHERE ${where}`,
    baseParams,
  );
  const total = Number((cntRows[0] as { cnt: number }).cnt ?? 0);

  const lim = Math.max(1, limit);
  const off = Math.max(0, offset);

  const jobCols = `j.id, j.owner, j.signerAddress, j.signerAddressesJson, j.status, j.mode, j.tokenAddress, j.chainId,
      j.scheduledAt, j.queuedAt, j.paused, j.createdAt, j.targetRunCount, j.currentRun`;

  const [rows] = await pool.execute<RowDataPacket[]>(
    `WITH page_ids AS (
       SELECT id FROM airdrop_jobs
       WHERE ${where}
       ORDER BY createdAt DESC, id DESC
       LIMIT ? OFFSET ?
     )
     SELECT ${jobCols}, agg.sum_total, agg.sum_success, agg.sum_failed, agg.sum_pending, agg.sum_queued, agg.sum_submitted
     FROM airdrop_jobs j
     INNER JOIN page_ids p ON j.id = p.id
     INNER JOIN (${aggregateSubquerySql}
     WHERE j2.id IN (SELECT id FROM page_ids)
     GROUP BY j2.id) agg ON j.id = agg.id
     ORDER BY j.createdAt DESC, j.id DESC`,
    [...baseParams, lim, off],
  );

  return {
    items: rows.map((row) => ({
      job: storedJobShellFromDbRow(row as unknown as JobRow),
      resultSummary: resultSummaryFromAggColumns(row),
    })),
    total,
  };
}
