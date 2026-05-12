import { NextResponse } from "next/server";
import { humanizeAirdropError } from "@/lib/humanize-airdrop-error";
import { getJob, saveJob } from "@/lib/job-service";
import type { StoredJob } from "@/lib/job-types";
import { triggerQueueTick } from "@/lib/job-queue";
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

type Params = { params: Promise<{ jobId: string }> };

export async function POST(request: Request, { params }: Params) {
  const session = await requireDistributorSession(request);
  if (session instanceof NextResponse) return session;

  const { jobId } = await params;
  const job = await getJob(jobId);
  if (!job) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }
  if (job.owner !== session.address.toLowerCase()) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (job.status === "completed") {
    return NextResponse.json({ error: "Job already completed" }, { status: 400 });
  }
  if (job.status === "cancelled") {
    return NextResponse.json({ error: "Cancelled job cannot be resumed" }, { status: 400 });
  }
  if (!job.paused && (job.status === "running" || job._runnerActive)) {
    return NextResponse.json({ error: "Job is already running" }, { status: 400 });
  }

  job.paused = false;
  job.status = "queued";
  job.queuedAt = new Date().toISOString();
  await saveJob(job);
  await triggerQueueTick();

  const latest = await getJob(jobId);
  return NextResponse.json({ ok: true, job: publicJob(latest ?? job) });
}
