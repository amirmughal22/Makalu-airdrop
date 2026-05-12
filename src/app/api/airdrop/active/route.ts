import { NextResponse } from "next/server";
import { humanizeAirdropError } from "@/lib/humanize-airdrop-error";
import { listActiveJobsForOwner, listActiveJobsSummaryForOwner } from "@/lib/job-service";
import type { StoredJob } from "@/lib/job-types";
import type { BatchResultSummary } from "@/lib/job-summary";
import { progressPercentFromSummary, summarizeBatchResults } from "@/lib/job-summary";
import { requireDistributorSession } from "@/lib/session";

function publicJob(job: StoredJob) {
  const { _runnerActive: _r, ...rest } = job;
  void _r;
  return {
    ...rest,
    results: rest.results.map((r) => ({
      ...r,
      error: r.error ? humanizeAirdropError(r.error) : undefined,
    })),
  };
}

function publicJobSummary(job: StoredJob, summary?: BatchResultSummary) {
  const { _runnerActive: _r, results, ...rest } = job;
  void _r;
  const resultSummary = summary ?? summarizeBatchResults(results);
  return {
    ...rest,
    results: [],
    resultSummary,
    progressPercent: progressPercentFromSummary(resultSummary),
  };
}

export async function GET(request: Request) {
  const session = await requireDistributorSession(request);
  if (session instanceof NextResponse) return session;
  const url = new URL(request.url);
  const limitRaw = parseInt(url.searchParams.get("limit") || "20", 10);
  const limit = Math.min(100, Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 20));
  const summary = url.searchParams.get("summary") === "1";
  const noStore = { headers: { "Cache-Control": "private, no-store, max-age=0" } };
  if (summary) {
    const rows = await listActiveJobsSummaryForOwner(session.address.toLowerCase(), limit);
    return NextResponse.json(
      {
        jobs: rows.map(({ job, resultSummary }) => publicJobSummary(job, resultSummary)),
      },
      noStore,
    );
  }
  const jobs = await listActiveJobsForOwner(session.address.toLowerCase(), limit);
  return NextResponse.json({ jobs: jobs.map(publicJob) }, noStore);
}
