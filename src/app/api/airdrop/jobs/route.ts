import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { isAddress } from "viem";
import { isSupportedChainId, MAKALU_CHAIN_ID_DECIMAL, resolvedChainName } from "@/lib/chain";
import { humanizeAirdropError } from "@/lib/humanize-airdrop-error";
import { getJob, saveJob } from "@/lib/job-service";
import { MAX_JOB_TARGET_RUNS, type RecipientInput, type StoredJob } from "@/lib/job-types";
import { ownerHasWallet } from "@/lib/distributor-wallet-store";
import { useNormalizedJobStorage } from "@/lib/normalized-job-config";
import { createNormalizedJob, startNormalizedJob } from "@/lib/queue/job-queue-repo";
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

export async function POST(request: Request) {
  const session = await requireDistributorSession(request);
  if (session instanceof NextResponse) return session;

  try {
    const body = (await request.json()) as {
      mode?: "native" | "erc20";
      tokenAddress?: string;
      recipients?: RecipientInput[];
      network?: { chainId?: number };
      distributorAddress?: string;
      distributorAddresses?: string[];
      /** Legacy JSON jobs only; normalized jobs always use one recipient pass per cycle. */
      targetRunCount?: number;
      /** Normalized queue: auto re-queue after each finished cycle until paused/cancelled. */
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
        { status: 400 }
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
        return NextResponse.json({ error: "One or more selected wallets are not available for this account." }, { status: 403 });
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

    const trRaw = body.targetRunCount == null ? 1 : Math.floor(Number(body.targetRunCount));
    const tr =
      Number.isFinite(trRaw) && trRaw >= 1 ? Math.min(MAX_JOB_TARGET_RUNS, trRaw) : 1;

    const jobId = randomUUID();
    const ownerLower = session.address.toLowerCase();

    if (useNormalizedJobStorage()) {
      await createNormalizedJob({
        jobId,
        ownerLower,
        name: null,
        mode,
        tokenAddress: mode === "erc20" ? tokenAddress ?? null : null,
        chainId,
        signerAddresses: distributorAddresses,
        recipients,
        targetRunCount: 1,
        loopForever,
      });
      const started = await startNormalizedJob(jobId, ownerLower);
      if (!started) {
        return NextResponse.json(
          {
            error:
              "Job rows were created but the job could not be queued (draft → queued). Inspect MySQL `jobs` / `job_wallets` and retry Start or queue-admin recover.",
          },
          { status: 500 },
        );
      }
      const created = await getJob(jobId);
      if (!created) {
        return NextResponse.json({ error: "Job was not persisted" }, { status: 500 });
      }
      return NextResponse.json({ job: publicJob(created) });
    }

    if (!Number.isFinite(trRaw) || trRaw < 1 || trRaw > MAX_JOB_TARGET_RUNS) {
      return NextResponse.json(
        { error: `targetRunCount must be between 1 and ${MAX_JOB_TARGET_RUNS.toLocaleString("en-US")}.` },
        { status: 400 },
      );
    }

    const job: StoredJob = {
      jobId,
      owner: ownerLower,
      signerAddress: distributorAddresses[0],
      signerAddresses: distributorAddresses,
      status: "draft",
      mode,
      tokenAddress: mode === "erc20" ? tokenAddress : undefined,
      chainId,
      createdAt: new Date().toISOString(),
      paused: false,
      targetRunCount: tr,
      currentRun: 1,
      loopForever,
      results: recipients.map((r) => ({
        recipient: r.address,
        amount: r.amount,
        status: "queued" as const,
      })),
    };
    await saveJob(job);
    return NextResponse.json({ job: publicJob(job) });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to create job" },
      { status: 400 }
    );
  }
}
