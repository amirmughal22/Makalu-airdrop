import { NextResponse } from "next/server";
import { getNormalizedJob } from "@/lib/queue/job-queue-repo";
import { requireNormalizedQueueApi } from "@/lib/queue/api-guards";
import type { NormalizedJobRow } from "@/lib/queue/types";
import { requireDistributorSession } from "@/lib/session";

function publicJob(j: NormalizedJobRow) {
  return {
    jobId: j.id,
    owner: j.owner,
    name: j.name,
    status: j.status,
    totalWallets: j.totalWallets,
    processedWallets: j.processedWallets,
    failedWallets: j.failedWallets,
    mode: j.mode,
    tokenAddress: j.tokenAddress ?? undefined,
    chainId: j.chainId ?? undefined,
    paused: j.paused,
    scheduledAt: j.scheduledAt,
    queuedAt: j.queuedAt,
    targetRunCount: j.targetRunCount,
    currentRun: j.currentRun,
    signerAddress: j.signerAddress ?? undefined,
    signerAddresses: j.signerAddresses ?? undefined,
    createdAt: j.createdAt,
    updatedAt: j.updatedAt,
  };
}

type Params = { params: Promise<{ jobId: string }> };

export async function GET(request: Request, { params }: Params) {
  const blocked = requireNormalizedQueueApi();
  if (blocked) return blocked;

  const session = await requireDistributorSession(request);
  if (session instanceof NextResponse) return session;

  const { jobId } = await params;
  const job = await getNormalizedJob(jobId);
  if (!job) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }
  if (job.owner !== session.address.toLowerCase()) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  return NextResponse.json({ job: publicJob(job) });
}
