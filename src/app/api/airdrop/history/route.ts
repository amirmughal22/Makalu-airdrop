import { NextResponse } from "next/server";
import { LIST_PAGE_SIZE } from "@/lib/list-page-size";
import {
  getQueuePositionsForJobIds,
  listJobsForOwnerPage,
  listJobsSummaryForOwnerPage,
  type HistoryStatusFilter,
} from "@/lib/job-service";
import { humanizeAirdropError } from "@/lib/humanize-airdrop-error";
import type { BatchResultSummary } from "@/lib/job-summary";
import { progressPercentFromSummary } from "@/lib/job-summary";
import type { StoredJob } from "@/lib/job-types";
import { requireDistributorSession } from "@/lib/session";

function publicJob(job: StoredJob, queuePosition?: number) {
  const { _runnerActive: _r, ...rest } = job;
  void _r;
  return {
    ...rest,
    queuePosition,
    results: rest.results.map((r) => ({
      ...r,
      error: r.error ? humanizeAirdropError(r.error) : undefined,
    })),
  };
}

function publicJobSummary(job: StoredJob, summary: BatchResultSummary, queuePosition?: number) {
  const { _runnerActive: _r, results: _rs, ...rest } = job;
  void _r;
  void _rs;
  return {
    ...rest,
    results: [],
    resultSummary: summary,
    progressPercent: progressPercentFromSummary(summary),
    queuePosition,
  };
}

export async function GET(request: Request) {
  const session = await requireDistributorSession(request);
  if (session instanceof NextResponse) return session;

  const url = new URL(request.url);
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1);
  const limitRaw = parseInt(url.searchParams.get("limit") || String(LIST_PAGE_SIZE), 10);
  const pageSize = Math.min(100, Math.max(1, Number.isFinite(limitRaw) ? limitRaw : LIST_PAGE_SIZE));
  const rawStatus = String(url.searchParams.get("statusFilter") || "all").toLowerCase();
  const statusFilter: HistoryStatusFilter =
    rawStatus === "running" || rawStatus === "paused" || rawStatus === "stopped" || rawStatus === "completed"
      ? rawStatus
      : "all";

  const summaryMode = url.searchParams.get("summary") === "1";
  const owner = session.address.toLowerCase();
  const nowIso = new Date().toISOString();
  const totalPagesBase = (total: number) => Math.max(1, Math.ceil(total / pageSize));

  if (summaryMode) {
    const { items, total } = await listJobsSummaryForOwnerPage(owner, page, pageSize, statusFilter);
    const queuedIdsOnPage = items.filter(({ job }) => job.status === "queued").map(({ job }) => job.jobId);
    const queuePosById = await getQueuePositionsForJobIds(queuedIdsOnPage, nowIso);
    return NextResponse.json(
      {
        jobs: items.map(({ job, resultSummary }) =>
          publicJobSummary(job, resultSummary, queuePosById.get(job.jobId)),
        ),
        total,
        page,
        pageSize,
        totalPages: totalPagesBase(total),
        statusFilter,
        summary: true,
      },
      { headers: { "Cache-Control": "private, no-store, max-age=0" } },
    );
  }

  const { jobs, total } = await listJobsForOwnerPage(owner, page, pageSize, statusFilter);
  const queuedIdsOnPage = jobs.filter((j) => j.status === "queued").map((j) => j.jobId);
  const queuePosById = await getQueuePositionsForJobIds(queuedIdsOnPage, nowIso);

  return NextResponse.json(
    {
      jobs: jobs.map((j) => publicJob(j, queuePosById.get(j.jobId))),
      total,
      page,
      pageSize,
      totalPages: totalPagesBase(total),
      statusFilter,
      summary: false,
    },
    { headers: { "Cache-Control": "private, no-store, max-age=0" } },
  );
}
