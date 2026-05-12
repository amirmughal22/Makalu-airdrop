import {
  claimQueuedDueJobFromDb,
  getJobSummarySnapshotFromDb,
  getQueuePositionsForJobIdsFromDb,
  getJobFromDb,
  listActiveJobsFromDb,
  listActiveJobsSummarySnapshotsFromDb,
  listJobsFromDbPage,
  listJobsSummarySnapshotsFromDbPage,
  listQueuedDueJobIdsFromDb,
  listQueuedDueJobsFromDb,
  listRunningJobsFromDb,
  listStaleRunningJobsFromDb,
  saveJobToDb,
} from "./job-db";
import {
  countNormalizedJobsForOwner,
  getNormalizedJobRow,
  getNormalizedQueuePositionsForJobIds,
  listNormalizedActiveJobs,
  listNormalizedJobsPage,
  updateNormalizedJobMeta,
  type NormalizedHistoryFilter,
} from "./normalized-job-db";
import { useNormalizedJobStorage } from "./normalized-job-config";
import {
  normalizedListRowToStoredJob,
  summaryFromNormalizedListRow,
} from "./normalized-job-adapter";
import {
  claimQueuedDueJobFromFile,
  getQueuePositionsForJobIdsFromFile,
  getJobFromFile,
  listActiveJobsFromFile,
  listJobsFromFilePage,
  listQueuedDueJobIdsFromFile,
  listQueuedDueJobsFromFile,
  listRunningJobsFromFile,
  listStaleRunningJobsFromFile,
  saveJobToFile,
} from "./job-file-store";
import { isJobRunActive } from "./job-runners";
import type { StoredJob } from "./job-types";
import { summarizeBatchResults, type BatchResultSummary } from "./job-summary";

export type HistoryStatusFilter = "all" | "running" | "paused" | "stopped" | "completed";

const { ensureDatabaseUrl } = require("../../database-url.js") as { ensureDatabaseUrl: () => void };

/** When true, jobs never use `data/airdrop-jobs.json` — DATABASE_URL (or split DB_* vars) must be set. */
function jobsDatabaseOnly(): boolean {
  const v = process.env.AIRDROP_JOBS_DATABASE_ONLY?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function databaseEnabled(): boolean {
  ensureDatabaseUrl();
  const hasUrl = Boolean(process.env.DATABASE_URL?.trim());
  if (jobsDatabaseOnly()) {
    if (!hasUrl) {
      throw new Error(
        "AIRDROP_JOBS_DATABASE_ONLY is enabled but no database URL is configured. Set DATABASE_URL, or DB_HOST + DB_USER + DB_PASSWORD + DB_DATABASE (or DB_NAME). See .env.example.",
      );
    }
    return true;
  }
  return hasUrl;
}

function asNormFilter(f: HistoryStatusFilter): NormalizedHistoryFilter {
  return f;
}

async function saveJobNormalized(job: StoredJob): Promise<void> {
  await updateNormalizedJobMeta(job.jobId, {
    status: job.status,
    paused: job.paused,
    queuedAt: job.queuedAt ? new Date(job.queuedAt) : null,
    scheduledAt: job.scheduledAt ? new Date(job.scheduledAt) : null,
    currentRun: job.currentRun,
    targetRunCount: job.targetRunCount,
  });
}

/** Load a job (file or MySQL/MariaDB). */
export async function getJob(jobId: string): Promise<StoredJob | undefined> {
  if (databaseEnabled() && useNormalizedJobStorage()) {
    const row = await getNormalizedJobRow(jobId);
    if (!row) return undefined;
    return { ...normalizedListRowToStoredJob(row), _runnerActive: isJobRunActive(jobId) };
  }
  const j = databaseEnabled() ? await getJobFromDb(jobId) : await getJobFromFile(jobId);
  if (!j) return undefined;
  return { ...j, _runnerActive: isJobRunActive(jobId) };
}

/**
 * Metadata + aggregate counts for `GET ?summary=1` without loading full `resultsJson` from DB when possible.
 * Falls back to a full row load if JSON aggregation is unsupported or fails.
 */
export async function getJobSummarySnapshot(
  jobId: string,
): Promise<{ job: StoredJob; resultSummary: BatchResultSummary } | undefined> {
  if (databaseEnabled() && useNormalizedJobStorage()) {
    const row = await getNormalizedJobRow(jobId);
    if (!row) return undefined;
    return {
      job: { ...normalizedListRowToStoredJob(row), _runnerActive: isJobRunActive(jobId) },
      resultSummary: summaryFromNormalizedListRow(row),
    };
  }
  if (databaseEnabled()) {
    try {
      const snap = await getJobSummarySnapshotFromDb(jobId);
      if (snap) {
        return { job: { ...snap.job, _runnerActive: isJobRunActive(jobId) }, resultSummary: snap.resultSummary };
      }
    } catch (e) {
      console.warn("[job-service] summary snapshot query failed; falling back to full row", e);
    }
    const full = await getJobFromDb(jobId);
    if (!full) return undefined;
    return {
      job: { ...full, results: [], _runnerActive: isJobRunActive(jobId) },
      resultSummary: summarizeBatchResults(full.results),
    };
  }
  const full = await getJobFromFile(jobId);
  if (!full) return undefined;
  return {
    job: { ...full, results: [], _runnerActive: isJobRunActive(jobId) },
    resultSummary: summarizeBatchResults(full.results),
  };
}

/** Active jobs with aggregate counts without shipping full `results` arrays when DB JSON aggregation succeeds. */
export async function listActiveJobsSummaryForOwner(
  ownerLower: string,
  limit: number,
): Promise<Array<{ job: StoredJob; resultSummary: BatchResultSummary }>> {
  if (databaseEnabled() && useNormalizedJobStorage()) {
    const rows = await listNormalizedActiveJobs(ownerLower, limit);
    return rows.map((row) => ({
      job: { ...normalizedListRowToStoredJob(row), _runnerActive: isJobRunActive(row.id) },
      resultSummary: summaryFromNormalizedListRow(row),
    }));
  }
  if (databaseEnabled()) {
    try {
      const rows = await listActiveJobsSummarySnapshotsFromDb(ownerLower, limit);
      return rows.map(({ job, resultSummary }) => ({
        job: { ...job, _runnerActive: isJobRunActive(job.jobId) },
        resultSummary,
      }));
    } catch (e) {
      console.warn("[job-service] active jobs summary query failed; falling back to full rows", e);
    }
    const items = await listActiveJobsFromDb(ownerLower, limit);
    return items.map((j) => ({
      job: { ...j, results: [], _runnerActive: isJobRunActive(j.jobId) },
      resultSummary: summarizeBatchResults(j.results),
    }));
  }
  const items = await listActiveJobsFromFile(ownerLower, limit);
  return items.map((j) => ({
    job: { ...j, results: [], _runnerActive: isJobRunActive(j.jobId) },
    resultSummary: summarizeBatchResults(j.results),
  }));
}

/** Atomically claim a due queued job before a runner starts it. */
export async function claimQueuedDueJob(jobId: string, nowIso: string): Promise<StoredJob | undefined> {
  const j = databaseEnabled()
    ? await claimQueuedDueJobFromDb(jobId, nowIso)
    : await claimQueuedDueJobFromFile(jobId, nowIso);
  if (!j) return undefined;
  return { ...j, _runnerActive: isJobRunActive(jobId) };
}

/** Persist full job state (after create or any mutation). */
export async function saveJob(job: StoredJob): Promise<void> {
  if (databaseEnabled() && useNormalizedJobStorage()) return saveJobNormalized(job);
  if (databaseEnabled()) return saveJobToDb(job);
  return saveJobToFile(job);
}

/** Paginated jobs for an owner (newest first). */
export async function listJobsForOwnerPage(
  ownerLower: string,
  page: number,
  pageSize: number,
  statusFilter: HistoryStatusFilter = "all",
): Promise<{ jobs: StoredJob[]; total: number }> {
  const safePage = Math.max(1, page);
  const safeSize = Math.max(1, pageSize);
  const offset = (safePage - 1) * safeSize;
  if (databaseEnabled() && useNormalizedJobStorage()) {
    const total = await countNormalizedJobsForOwner(ownerLower, asNormFilter(statusFilter));
    const rows = await listNormalizedJobsPage(ownerLower, offset, safeSize, asNormFilter(statusFilter));
    return {
      jobs: rows.map((row) => ({
        ...normalizedListRowToStoredJob(row),
        _runnerActive: isJobRunActive(row.id),
      })),
      total,
    };
  }
  const { items, total } = databaseEnabled()
    ? await listJobsFromDbPage(ownerLower, offset, safeSize, statusFilter)
    : await listJobsFromFilePage(ownerLower, offset, safeSize, statusFilter);
  return {
    jobs: items.map((j) => ({ ...j, _runnerActive: isJobRunActive(j.jobId) })),
    total,
  };
}

/** Paginated history list without shipping full `results` arrays when DB JSON aggregation succeeds. */
export async function listJobsSummaryForOwnerPage(
  ownerLower: string,
  page: number,
  pageSize: number,
  statusFilter: HistoryStatusFilter = "all",
): Promise<{ items: Array<{ job: StoredJob; resultSummary: BatchResultSummary }>; total: number }> {
  const safePage = Math.max(1, page);
  const safeSize = Math.max(1, pageSize);
  const offset = (safePage - 1) * safeSize;
  if (databaseEnabled() && useNormalizedJobStorage()) {
    const total = await countNormalizedJobsForOwner(ownerLower, asNormFilter(statusFilter));
    const rows = await listNormalizedJobsPage(ownerLower, offset, safeSize, asNormFilter(statusFilter));
    return {
      items: rows.map((row) => ({
        job: { ...normalizedListRowToStoredJob(row), _runnerActive: isJobRunActive(row.id) },
        resultSummary: summaryFromNormalizedListRow(row),
      })),
      total,
    };
  }
  if (databaseEnabled()) {
    try {
      const out = await listJobsSummarySnapshotsFromDbPage(ownerLower, offset, safeSize, statusFilter);
      return {
        items: out.items.map(({ job, resultSummary }) => ({
          job: { ...job, _runnerActive: isJobRunActive(job.jobId) },
          resultSummary,
        })),
        total: out.total,
      };
    } catch (e) {
      console.warn("[job-service] summary history page failed; falling back to full rows", e);
      const full = await listJobsFromDbPage(ownerLower, offset, safeSize, statusFilter);
      return {
        items: full.items.map((j) => ({
          job: { ...j, results: [], _runnerActive: isJobRunActive(j.jobId) },
          resultSummary: summarizeBatchResults(j.results),
        })),
        total: full.total,
      };
    }
  }
  const full = await listJobsFromFilePage(ownerLower, offset, safeSize, statusFilter);
  return {
    items: full.items.map((j) => ({
      job: { ...j, results: [], _runnerActive: isJobRunActive(j.jobId) },
      resultSummary: summarizeBatchResults(j.results),
    })),
    total: full.total,
  };
}

export async function listQueuedDueJobs(limit: number, nowIso: string): Promise<StoredJob[]> {
  const items = databaseEnabled()
    ? await listQueuedDueJobsFromDb(limit, nowIso)
    : await listQueuedDueJobsFromFile(limit, nowIso);
  return items.map((j) => ({ ...j, _runnerActive: isJobRunActive(j.jobId) }));
}

/** Ordered global queue job ids (cheap — no recipient payloads). */
export async function listQueuedDueJobIds(limit: number, nowIso: string): Promise<string[]> {
  return databaseEnabled()
    ? await listQueuedDueJobIdsFromDb(limit, nowIso)
    : await listQueuedDueJobIdsFromFile(limit, nowIso);
}

/** Queue positions for specific jobs only (avoids loading every queued job’s full row). */
export async function getQueuePositionsForJobIds(jobIds: string[], nowIso: string): Promise<Map<string, number>> {
  if (jobIds.length === 0) return new Map();
  if (databaseEnabled() && useNormalizedJobStorage()) return getNormalizedQueuePositionsForJobIds(jobIds, nowIso);
  if (databaseEnabled()) return getQueuePositionsForJobIdsFromDb(jobIds, nowIso);
  return getQueuePositionsForJobIdsFromFile(jobIds, nowIso);
}

export async function listActiveJobsForOwner(ownerLower: string, limit: number): Promise<StoredJob[]> {
  if (databaseEnabled() && useNormalizedJobStorage()) {
    const rows = await listNormalizedActiveJobs(ownerLower, limit);
    return rows.map((row) => ({
      ...normalizedListRowToStoredJob(row),
      _runnerActive: isJobRunActive(row.id),
    }));
  }
  const items = databaseEnabled()
    ? await listActiveJobsFromDb(ownerLower, limit)
    : await listActiveJobsFromFile(ownerLower, limit);
  return items.map((j) => ({ ...j, _runnerActive: isJobRunActive(j.jobId) }));
}

export async function listRunningJobs(limit: number): Promise<StoredJob[]> {
  const items = databaseEnabled()
    ? await listRunningJobsFromDb(limit)
    : await listRunningJobsFromFile(limit);
  return items.map((j) => ({ ...j, _runnerActive: isJobRunActive(j.jobId) }));
}

export async function listStaleRunningJobs(limit: number, staleBeforeIso: string): Promise<StoredJob[]> {
  const items = databaseEnabled()
    ? await listStaleRunningJobsFromDb(limit, staleBeforeIso)
    : await listStaleRunningJobsFromFile(limit);
  return items.map((j) => ({ ...j, _runnerActive: isJobRunActive(j.jobId) }));
}

export { tryAcquireJobRun, releaseJobRun, isJobRunActive } from "./job-runners";
