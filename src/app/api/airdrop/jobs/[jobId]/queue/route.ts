import { NextResponse } from "next/server";
import { humanizeAirdropError } from "@/lib/humanize-airdrop-error";
import { getJob, saveJob } from "@/lib/job-service";
import type { StoredJob } from "@/lib/job-types";
import { triggerQueueTick } from "@/lib/job-queue";
import { requeueIncompleteWallets } from "@/lib/normalized-job-db";
import { useNormalizedJobStorage } from "@/lib/normalized-job-config";
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
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });
  if (job.owner !== session.address.toLowerCase()) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (job.status === "running" || job._runnerActive) return NextResponse.json({ error: "Running job cannot be re-queued." }, { status: 400 });
  if (job.status === "completed" || job.status === "cancelled") {
    return NextResponse.json({ error: "Completed/cancelled job cannot be queued." }, { status: 400 });
  }

  const body = (await request.json().catch(() => ({}))) as { scheduledAt?: string | null };
  if (body.scheduledAt) {
    const dt = new Date(body.scheduledAt);
    if (!Number.isFinite(dt.getTime())) return NextResponse.json({ error: "Invalid schedule time." }, { status: 400 });
    job.scheduledAt = dt.toISOString();
  } else {
    job.scheduledAt = undefined;
  }
  job.status = "queued";
  job.queuedAt = new Date().toISOString();
  job.paused = false;
  if (useNormalizedJobStorage()) {
    await requeueIncompleteWallets(jobId);
  } else {
    for (const r of job.results) {
      if (r.status !== "success") {
        r.status = "queued";
        r.error = undefined;
        r.txHash = undefined;
        r.rpcUrl = undefined;
      }
    }
  }
  await saveJob(job);
  await triggerQueueTick();
  const latest = await getJob(jobId);
  return NextResponse.json({ ok: true, job: publicJob(latest ?? job) });
}
