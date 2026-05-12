import { NextResponse } from "next/server";
import { getNormalizedJob, startNormalizedJob } from "@/lib/queue/job-queue-repo";
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

export async function POST(request: Request, { params }: Params) {
  const blocked = requireNormalizedQueueApi();
  if (blocked) return blocked;

  const session = await requireDistributorSession(request);
  if (session instanceof NextResponse) return session;

  const { jobId } = await params;
  const existing = await getNormalizedJob(jobId);
  if (!existing) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }
  if (existing.owner !== session.address.toLowerCase()) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (existing.status !== "draft") {
    return NextResponse.json({ error: "Only draft jobs can be started via this endpoint." }, { status: 400 });
  }

  const ok = await startNormalizedJob(jobId, session.address.toLowerCase());
  if (!ok) {
    return NextResponse.json({ error: "Could not start job" }, { status: 400 });
  }

  const latest = await getNormalizedJob(jobId);
  return NextResponse.json({ ok: true, job: latest ? publicJob(latest) : undefined });
}
