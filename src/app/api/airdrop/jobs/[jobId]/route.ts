import { randomUUID } from "node:crypto";
import { assertSignerCountWithinJobLimit } from "@/lib/airdrop-signer-limits";
import { NextResponse } from "next/server";
import { isAddress } from "viem";
import { MAKALU_CHAIN_ID_DECIMAL } from "@/lib/chain";
import { humanizeAirdropError } from "@/lib/humanize-airdrop-error";
import { getJob, getJobSummarySnapshot, saveJob } from "@/lib/job-service";
import type { StoredJob } from "@/lib/job-types";
import { ownerHasWallet } from "@/lib/distributor-wallet-store";
import type { BatchResultSummary } from "@/lib/job-summary";
import { progressPercentFromSummary, summarizeBatchResults } from "@/lib/job-summary";
import { getNormalizedJobRow } from "@/lib/normalized-job-db";
import { normalizedRowToProgressStats } from "@/lib/normalized-job-adapter";
import { useNormalizedJobStorage } from "@/lib/normalized-job-config";
import { collectEmbeddedWorkerBlockers, collectQueueClaimBlockers } from "@/lib/queue/config";
import { refreshQueueRuntimeCache } from "@/lib/queue/queue-runtime-settings";
import { replaceNormalizedDraftJobWallets } from "@/lib/queue/job-queue-repo";
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

/** Same metadata as {@link publicJob} but omits per-recipient rows — only aggregate counts. */
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

type Params = { params: Promise<{ jobId: string }> };

async function normalizedQueueDiagnostics() {
  await refreshQueueRuntimeCache();
  return {
    queueClaimBlockers: collectQueueClaimBlockers(),
    embeddedWorkerBlockers: collectEmbeddedWorkerBlockers(),
  };
}

export async function GET(request: Request, { params }: Params) {
  const session = await requireDistributorSession(request);
  if (session instanceof NextResponse) return session;

  const { jobId } = await params;
  const url = new URL(request.url);
  const summary = url.searchParams.get("summary") === "1";
  if (summary) {
    const snap = await getJobSummarySnapshot(jobId);
    if (!snap) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 });
    }
    if (snap.job.owner !== session.address.toLowerCase()) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    const row = useNormalizedJobStorage() ? await getNormalizedJobRow(jobId) : null;
    const stats = row ? normalizedRowToProgressStats(row) : undefined;
    const queueDiag = row ? await normalizedQueueDiagnostics() : undefined;
    return NextResponse.json(
      {
        job: publicJobSummary(snap.job, snap.resultSummary),
        ...(stats ? { stats } : {}),
        ...(queueDiag ?? {}),
      },
      { headers: { "Cache-Control": "private, no-store, max-age=0" } },
    );
  }

  const job = await getJob(jobId);
  if (!job) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }
  if (job.owner !== session.address.toLowerCase()) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const row = useNormalizedJobStorage() ? await getNormalizedJobRow(jobId) : null;
  const stats = row ? normalizedRowToProgressStats(row) : undefined;
  const queueDiag = row ? await normalizedQueueDiagnostics() : undefined;
  return NextResponse.json(
    {
      job: publicJob(job),
      ...(stats ? { stats } : {}),
      ...(queueDiag ?? {}),
    },
    { headers: { "Cache-Control": "private, no-store, max-age=0" } },
  );
}

export async function PATCH(request: Request, { params }: Params) {
  const session = await requireDistributorSession(request);
  if (session instanceof NextResponse) return session;

  const { jobId } = await params;
  const job = await getJob(jobId);
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });
  if (job.owner !== session.address.toLowerCase()) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (job.status !== "draft" && job.status !== "queued") {
    return NextResponse.json({ error: "Only draft/queued jobs can be edited." }, { status: 400 });
  }

  try {
    const body = (await request.json()) as {
      mode?: "native" | "erc20";
      tokenAddress?: string;
      recipients?: Array<{ address: string; amount: string }>;
      scheduledAt?: string | null;
      distributorAddress?: string;
      distributorAddresses?: string[];
    };

    if (typeof body.mode === "string") job.mode = body.mode === "erc20" ? "erc20" : "native";
    if (body.tokenAddress !== undefined) job.tokenAddress = body.tokenAddress?.trim() || undefined;
    if (body.distributorAddresses !== undefined || body.distributorAddress !== undefined) {
      const raw =
        Array.isArray(body.distributorAddresses) && body.distributorAddresses.length > 0
          ? body.distributorAddresses
          : body.distributorAddress
            ? [body.distributorAddress]
            : [];
      const nextList = [...new Set(raw.map((a) => String(a || "").trim().toLowerCase()).filter(Boolean))];
      if (nextList.length === 0 || nextList.some((a) => !isAddress(a))) {
        return NextResponse.json({ error: "Invalid distributor wallet selection." }, { status: 400 });
      }
      try {
        assertSignerCountWithinJobLimit(nextList);
      } catch (e) {
        return NextResponse.json({ error: e instanceof Error ? e.message : "Too many distributor wallets" }, { status: 400 });
      }
      for (const a of nextList) {
        if (!ownerHasWallet(session.address, a)) {
          return NextResponse.json({ error: "Invalid distributor wallet selection." }, { status: 400 });
        }
      }
      job.signerAddresses = nextList;
      job.signerAddress = nextList[0];
    }
    if (body.scheduledAt !== undefined) {
      if (!body.scheduledAt) {
        job.scheduledAt = undefined;
      } else {
        const dt = new Date(body.scheduledAt);
        if (!Number.isFinite(dt.getTime())) return NextResponse.json({ error: "Invalid schedule time." }, { status: 400 });
        job.scheduledAt = dt.toISOString();
      }
    }
    if (body.recipients) {
      if (!Array.isArray(body.recipients) || body.recipients.length === 0) {
        return NextResponse.json({ error: "Recipients are required." }, { status: 400 });
      }
      const mapped = body.recipients.map((r) => {
        const address = String(r.address || "").trim();
        const amount = String(r.amount || "").trim();
        if (!isAddress(address)) throw new Error(`Invalid recipient address: ${address}`);
        const n = Number(amount);
        if (!Number.isFinite(n) || n < 0) throw new Error(`Invalid amount for ${address}`);
        return { recipient: address, amount, status: "queued" as const };
      });
      if (useNormalizedJobStorage()) {
        const signers = job.signerAddresses?.length ? job.signerAddresses : job.signerAddress ? [job.signerAddress] : [];
        await replaceNormalizedDraftJobWallets({
          jobId,
          ownerLower: session.address.toLowerCase(),
          name: undefined,
          mode: job.mode,
          tokenAddress: job.mode === "erc20" ? job.tokenAddress ?? null : null,
          chainId: job.chainId ?? MAKALU_CHAIN_ID_DECIMAL,
          signerAddresses: signers,
          recipients: mapped.map((r) => ({
            id: randomUUID(),
            address: r.recipient,
            amount: r.amount,
          })),
          targetRunCount: job.targetRunCount ?? 1,
        });
      } else {
        job.results = mapped;
      }
    }
    if (job.mode === "erc20") {
      if (!job.tokenAddress || !isAddress(job.tokenAddress)) {
        return NextResponse.json({ error: "Valid token contract required for ERC-20 mode." }, { status: 400 });
      }
    } else {
      job.tokenAddress = undefined;
    }
    const signers = job.signerAddresses?.length ? job.signerAddresses : job.signerAddress ? [job.signerAddress] : [];
    if (
      signers.length === 0 ||
      signers.some((a) => !ownerHasWallet(session.address, a))
    ) {
      return NextResponse.json({ error: "Selected distributor wallet(s) are unavailable." }, { status: 400 });
    }
    await saveJob(job);
    const latest = await getJob(jobId);
    return NextResponse.json({ job: publicJob(latest ?? job) });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed to update job" }, { status: 400 });
  }
}
