import { hydrateIfNeeded, persistJobsToDisk } from "./job-persistence";
import type { StoredJob } from "./job-types";
import type { HistoryStatusFilter } from "./job-service";

const g = globalThis as unknown as { __makaluJobs?: Map<string, StoredJob> };

function jobsMap(): Map<string, StoredJob> {
  if (!g.__makaluJobs) g.__makaluJobs = new Map();
  hydrateIfNeeded(g.__makaluJobs);
  return g.__makaluJobs;
}

export async function getJobFromFile(jobId: string): Promise<StoredJob | undefined> {
  return jobsMap().get(jobId);
}

export async function claimQueuedDueJobFromFile(jobId: string, nowIso: string): Promise<StoredJob | undefined> {
  const job = jobsMap().get(jobId);
  if (!job) return undefined;
  const now = new Date(nowIso).getTime();
  if (job.status !== "queued" || job.paused) return undefined;
  if (job.scheduledAt && new Date(job.scheduledAt).getTime() > now) return undefined;
  job.status = "running";
  job.paused = false;
  await saveJobToFile(job);
  return job;
}

export async function saveJobToFile(job: StoredJob): Promise<void> {
  jobsMap().set(job.jobId, job);
  persistJobsToDisk(jobsMap());
}

export async function listJobsFromFilePage(
  ownerLower: string,
  offset: number,
  limit: number,
  statusFilter: HistoryStatusFilter = "all",
): Promise<{ items: StoredJob[]; total: number }> {
  const sorted = [...jobsMap().values()]
    .filter((j) => j.owner === ownerLower)
    .filter((j) => {
      if (statusFilter === "running") return j.status === "running" || j.status === "queued";
      if (statusFilter === "paused") return j.status === "paused";
      if (statusFilter === "stopped") return j.status === "failed" || j.status === "cancelled";
      if (statusFilter === "completed") return j.status === "completed";
      return true;
    })
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  const total = sorted.length;
  return { items: sorted.slice(offset, offset + limit), total };
}

export async function listActiveJobsFromFile(ownerLower: string, limit: number): Promise<StoredJob[]> {
  return [...jobsMap().values()]
    .filter((j) => j.owner === ownerLower)
    .filter((j) => j.status !== "completed" && j.status !== "failed" && j.status !== "cancelled")
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, Math.max(1, limit));
}

export async function listQueuedDueJobsFromFile(limit: number, nowIso: string): Promise<StoredJob[]> {
  const now = new Date(nowIso).getTime();
  return [...jobsMap().values()]
    .filter((j) => j.status === "queued")
    .filter((j) => !j.paused)
    .filter((j) => !j.scheduledAt || new Date(j.scheduledAt).getTime() <= now)
    .sort((a, b) => {
      const aq = new Date(a.queuedAt || a.createdAt).getTime();
      const bq = new Date(b.queuedAt || b.createdAt).getTime();
      if (aq !== bq) return aq - bq;
      return a.jobId.localeCompare(b.jobId);
    })
    .slice(0, Math.max(1, limit));
}

export async function listQueuedDueJobIdsFromFile(limit: number, nowIso: string): Promise<string[]> {
  const jobs = await listQueuedDueJobsFromFile(limit, nowIso);
  return jobs.map((j) => j.jobId);
}

export function getQueuePositionsForJobIdsFromFile(jobIds: string[], nowIso: string): Map<string, number> {
  const need = new Set(jobIds);
  if (need.size === 0) return new Map();

  const now = new Date(nowIso).getTime();
  const ordered = [...jobsMap().values()]
    .filter((j) => j.status === "queued")
    .filter((j) => !j.paused)
    .filter((j) => !j.scheduledAt || new Date(j.scheduledAt).getTime() <= now)
    .sort((a, b) => {
      const aq = new Date(a.queuedAt || a.createdAt).getTime();
      const bq = new Date(b.queuedAt || b.createdAt).getTime();
      if (aq !== bq) return aq - bq;
      return a.jobId.localeCompare(b.jobId);
    });

  const m = new Map<string, number>();
  let filled = 0;
  for (let i = 0; i < ordered.length; i++) {
    const id = ordered[i]!.jobId;
    if (need.has(id)) {
      m.set(id, i + 1);
      filled += 1;
      if (filled >= need.size) break;
    }
  }
  return m;
}

export async function listRunningJobsFromFile(limit: number): Promise<StoredJob[]> {
  return [...jobsMap().values()]
    .filter((j) => j.status === "running")
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, Math.max(1, limit));
}

export async function listStaleRunningJobsFromFile(limit: number): Promise<StoredJob[]> {
  return listRunningJobsFromFile(limit);
}
