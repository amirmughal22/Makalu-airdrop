import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { isAddress } from "viem";
import { isSupportedChainId, MAKALU_CHAIN_ID_DECIMAL, resolvedChainName } from "@/lib/chain";
import { ownerHasWallet } from "@/lib/distributor-wallet-store";
import type { RecipientInput } from "@/lib/job-types";
import { createNormalizedJob, getNormalizedJob, startNormalizedJob } from "@/lib/queue/job-queue-repo";
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
    loopForever: j.loopForever,
    signerAddress: j.signerAddress ?? undefined,
    signerAddresses: j.signerAddresses ?? undefined,
    createdAt: j.createdAt,
    updatedAt: j.updatedAt,
  };
}

export async function POST(request: Request) {
  const blocked = requireNormalizedQueueApi();
  if (blocked) return blocked;

  const session = await requireDistributorSession(request);
  if (session instanceof NextResponse) return session;

  try {
    const body = (await request.json()) as {
      name?: string;
      mode?: "native" | "erc20";
      tokenAddress?: string;
      recipients?: RecipientInput[];
      network?: { chainId?: number };
      distributorAddress?: string;
      distributorAddresses?: string[];
      /** Ignored for normalized jobs — one recipient pass per cycle; use `loopForever` for continuous reruns. */
      targetRunCount?: number;
      loopForever?: boolean;
    };

    const mode = body.mode === "erc20" ? "erc20" : "native";
    const tokenAddress = body.tokenAddress?.trim();
    const recipients = body.recipients ?? [];
    const rawList =
      Array.isArray(body.distributorAddresses) && body.distributorAddresses.length > 0
        ? body.distributorAddresses
        : body.distributorAddress
          ? [body.distributorAddress]
          : [];
    const distributorAddresses = [...new Set(rawList.map((a) => String(a || "").trim().toLowerCase()).filter(Boolean))];

    const chainId = Number(body.network?.chainId ?? MAKALU_CHAIN_ID_DECIMAL);
    if (!Number.isFinite(chainId) || !isSupportedChainId(chainId)) {
      return NextResponse.json(
        { error: `Unsupported chain — use ${resolvedChainName()} (${MAKALU_CHAIN_ID_DECIMAL}).` },
        { status: 400 },
      );
    }
    if (!recipients.length) {
      return NextResponse.json({ error: "No recipients" }, { status: 400 });
    }
    if (distributorAddresses.length === 0 || distributorAddresses.some((a) => !isAddress(a))) {
      return NextResponse.json({ error: "Select one or more valid distributor wallets." }, { status: 400 });
    }
    for (const a of distributorAddresses) {
      if (!ownerHasWallet(session.address, a)) {
        return NextResponse.json(
          { error: "One or more selected wallets are not available for this account." },
          { status: 403 },
        );
      }
    }
    if (mode === "erc20") {
      if (!tokenAddress || !isAddress(tokenAddress)) {
        return NextResponse.json({ error: "Valid token contract required for ERC-20" }, { status: 400 });
      }
    }

    for (const r of recipients) {
      if (!r.address || !isAddress(r.address)) {
        return NextResponse.json({ error: `Invalid recipient address: ${r.address}` }, { status: 400 });
      }
      const amt = Number(r.amount);
      if (!Number.isFinite(amt) || amt < 0) {
        return NextResponse.json({ error: `Invalid amount for ${r.address}` }, { status: 400 });
      }
    }

    const loopForever = body.loopForever === true;

    const jobId = randomUUID();
    const ownerLower = session.address.toLowerCase();
    await createNormalizedJob({
      jobId,
      ownerLower,
      name: body.name?.trim() || null,
      mode,
      tokenAddress: mode === "erc20" ? tokenAddress : null,
      chainId,
      signerAddresses: distributorAddresses,
      recipients: recipients.map((r) => ({
        id: r.id,
        address: r.address,
        amount: String(r.amount),
        source: r.source,
      })),
      targetRunCount: 1,
      loopForever,
    });
    const started = await startNormalizedJob(jobId, ownerLower);
    if (!started) {
      return NextResponse.json(
        {
          error:
            "Job rows were created but the job could not be queued (draft → queued). Inspect MySQL and run queue-admin recover-stalled-queue if needed.",
        },
        { status: 500 },
      );
    }

    const job = await getNormalizedJob(jobId);
    if (!job) {
      return NextResponse.json({ error: "Job was not persisted" }, { status: 500 });
    }
    return NextResponse.json({ job: publicJob(job) });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to create job" },
      { status: 400 },
    );
  }
}
