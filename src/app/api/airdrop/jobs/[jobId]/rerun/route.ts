import { NextResponse } from "next/server";
import { humanizeAirdropError } from "@/lib/humanize-airdrop-error";
import { getJob, saveJob } from "@/lib/job-service";
import { MAX_JOB_TARGET_RUNS, type StoredJob } from "@/lib/job-types";
import { triggerQueueTick } from "@/lib/job-queue";
import { rerunNormalizedJob } from "@/lib/normalized-job-db";
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

/** Full rerun: reset all transfers and queue the job again (same recipients and pass count). */
export async function POST(request: Request, { params }: Params) {
  const session = await requireDistributorSession(request);
  if (session instanceof NextResponse) return session;

  const { jobId } = await params;
  const job = await getJob(jobId);
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });
  if (job.owner !== session.address.toLowerCase()) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (job.status === "cancelled") {
    return NextResponse.json({ error: "Cancelled jobs cannot be rerun." }, { status: 400 });
  }

  const stillBusy = !job.paused && (job.status === "running" || job._runnerActive);
  if (stillBusy) {
    return NextResponse.json({ error: "Cannot rerun while the job is running." }, { status: 400 });
  }

  if (useNormalizedJobStorage()) {
    await rerunNormalizedJob(jobId);
  } else {
    for (const r of job.results) {
      r.status = "queued";
      r.error = undefined;
      r.txHash = undefined;
      r.signerAddress = undefined;
      r.rpcUrl = undefined;
    }
    job.currentRun = 1;
    job.targetRunCount = Math.max(1, Math.min(MAX_JOB_TARGET_RUNS, job.targetRunCount ?? 1));
    job.status = "queued";
    job.queuedAt = new Date().toISOString();
    job.paused = false;
    job.scheduledAt = undefined;

    await saveJob(job);
  }
  await triggerQueueTick();
  const latest = await getJob(jobId);
  return NextResponse.json({ ok: true, job: publicJob(latest ?? job) });
}
