import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { isAddress } from "viem";
import { assertSignerCountWithinJobLimit } from "@/lib/airdrop-signer-limits";
import { isSupportedChainId, MAKALU_CHAIN_ID_DECIMAL, resolvedChainName } from "@/lib/chain";
import { humanizeAirdropError } from "@/lib/humanize-airdrop-error";
import { getJob, saveJob } from "@/lib/job-service";
import { MAX_JOB_TARGET_RUNS, type RecipientInput, type StoredJob } from "@/lib/job-types";
import { ownerHasWallet } from "@/lib/distributor-wallet-store";
import { useNormalizedJobStorage } from "@/lib/normalized-job-config";
import { readErc20Decimals } from "@/lib/evm-send-transfer";
import { createNormalizedJob, createNormalizedJobFromGeneratedBatch, startNormalizedJob } from "@/lib/queue/job-queue-repo";
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
      /** `recipients` (default) or `generated_batch` (PostgreSQL saved wallets). */
      walletSource?: "recipients" | "generated_batch";
      generatedBatchId?: string;
      fromWalletIndex?: number;
      toWalletIndex?: number;
      /** Required when walletSource is generated_batch and splitMode is equalTotal. */
      uniformAmount?: string | number;
      /** For generated_batch: equalTotal (uniform) vs randomRange (min/max per row). */
      splitMode?: "equalTotal" | "randomRange";
      minAmount?: string;
      maxAmount?: string;
      jobName?: string;
    };

    const walletSource = body.walletSource === "generated_batch" ? "generated_batch" : "recipients";

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
    if (walletSource !== "generated_batch" && !recipients.length) {
      return NextResponse.json({ error: "No recipients" }, { status: 400 });
    }
    if (distributorAddresses.length === 0 || distributorAddresses.some((a) => !isAddress(a))) {
      return NextResponse.json({ error: "Select one or more valid distributor wallets." }, { status: 400 });
    }
    try {
      assertSignerCountWithinJobLimit(distributorAddresses);
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : "Too many distributor wallets" }, { status: 400 });
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

    if (walletSource === "generated_batch" && !useNormalizedJobStorage()) {
      return NextResponse.json(
        { error: "Saved wallet batches require normalized PostgreSQL jobs (DATABASE_URL + normalized storage)." },
        { status: 400 },
      );
    }

    if (walletSource === "recipients") {
      for (const r of recipients) {
        if (!r.address || !isAddress(r.address)) {
          return NextResponse.json({ error: `Invalid recipient address: ${r.address}` }, { status: 400 });
        }
        const amt = Number(r.amount);
        if (!Number.isFinite(amt) || amt < 0) {
          return NextResponse.json({ error: `Invalid amount for ${r.address}` }, { status: 400 });
        }
      }
    }

    const loopForever = body.loopForever === true;

    const trRaw = body.targetRunCount == null ? 1 : Math.floor(Number(body.targetRunCount));
    const tr =
      Number.isFinite(trRaw) && trRaw >= 1 ? Math.min(MAX_JOB_TARGET_RUNS, trRaw) : 1;

    const jobId = randomUUID();
    const ownerLower = session.address.toLowerCase();

    const jobName = typeof body.jobName === "string" ? body.jobName.trim() : "";

    if (useNormalizedJobStorage()) {
      if (walletSource === "generated_batch") {
        const batchId = String(body.generatedBatchId ?? "").trim();
        const fromW = Math.floor(Number(body.fromWalletIndex));
        const toW = Math.floor(Number(body.toWalletIndex));
        const batchSplit = body.splitMode === "equalTotal" ? "equalTotal" : "randomRange";
        if (!batchId) return NextResponse.json({ error: "generatedBatchId is required" }, { status: 400 });
        if (!Number.isFinite(fromW) || !Number.isFinite(toW)) {
          return NextResponse.json({ error: "fromWalletIndex and toWalletIndex must be integers" }, { status: 400 });
        }
        if (batchSplit === "equalTotal") {
          const uniform = body.uniformAmount != null ? String(body.uniformAmount).trim() : "";
          const uamt = Number(uniform);
          if (!uniform || !Number.isFinite(uamt) || uamt < 0) {
            return NextResponse.json({ error: "uniformAmount must be a non-negative number" }, { status: 400 });
          }
          await createNormalizedJobFromGeneratedBatch({
            jobId,
            ownerLower,
            name: jobName || null,
            mode,
            tokenAddress: mode === "erc20" ? tokenAddress ?? null : null,
            chainId,
            signerAddresses: distributorAddresses,
            generatedBatchId: batchId,
            fromWalletIndex: fromW,
            toWalletIndex: toW,
            loopForever,
            amountMode: "uniform",
            uniformAmount: uniform,
          });
        } else {
          const minA = String(body.minAmount ?? "").trim();
          const maxA = String(body.maxAmount ?? "").trim();
          if (!minA || !maxA) {
            return NextResponse.json(
              { error: "minAmount and maxAmount are required for random-range saved batch jobs" },
              { status: 400 },
            );
          }
          const lo = Number(minA);
          const hi = Number(maxA);
          if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo < 0 || hi < lo) {
            return NextResponse.json({ error: "Invalid min and max amounts" }, { status: 400 });
          }
          let tokenDecimals = 18;
          if (mode === "erc20" && tokenAddress) {
            tokenDecimals = await readErc20Decimals(tokenAddress as `0x${string}`, chainId);
          }
          await createNormalizedJobFromGeneratedBatch({
            jobId,
            ownerLower,
            name: jobName || null,
            mode,
            tokenAddress: mode === "erc20" ? tokenAddress ?? null : null,
            chainId,
            signerAddresses: distributorAddresses,
            generatedBatchId: batchId,
            fromWalletIndex: fromW,
            toWalletIndex: toW,
            loopForever,
            amountMode: "randomRange",
            minAmount: minA,
            maxAmount: maxA,
            tokenDecimals,
          });
        }
      } else {
        await createNormalizedJob({
          jobId,
          ownerLower,
          name: jobName || null,
          mode,
          tokenAddress: mode === "erc20" ? tokenAddress ?? null : null,
          chainId,
          signerAddresses: distributorAddresses,
          recipients,
          targetRunCount: 1,
          loopForever,
        });
      }
      const started = await startNormalizedJob(jobId, ownerLower);
      if (!started) {
        return NextResponse.json(
          {
            error:
              "Job rows were created but the job could not be queued (draft → queued). Inspect PostgreSQL `jobs` / `job_wallets` and retry Start or queue-admin recover.",
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
