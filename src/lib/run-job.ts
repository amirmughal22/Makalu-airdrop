import { type Account, createPublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { MAKALU_CHAIN_ID_DECIMAL, httpTransportForChainId, viemChainForChainId } from "./chain";
import { erc20Abi } from "./erc20";
import { executeEvmTransfer } from "./evm-send-transfer";
import { humanizeAirdropError } from "./humanize-airdrop-error";
import { getOwnerWalletPrivateKey } from "./distributor-wallet-store";
import { interChunkDelayMs, maxParallelTxsPerWave, sleep } from "./rpc-retry";
import { getJob, releaseJobRun, saveJob, tryAcquireJobRun } from "./job-service";
import { MAX_JOB_TARGET_RUNS, type BatchResult, type StoredJob } from "./job-types";

function errMsg(e: unknown) {
  return humanizeAirdropError(e);
}

type WalletBundle = {
  addressLower: string;
  account: Account;
};

export function runAirdropJob(jobId: string): void {
  void executeJob(jobId);
}

function signerListForJob(job: StoredJob): string[] {
  if (job.signerAddresses && job.signerAddresses.length > 0) {
    return [...new Set(job.signerAddresses.map((a) => a.toLowerCase()))];
  }
  const one = (job.signerAddress || job.owner).toLowerCase();
  return [one];
}

async function executeJob(jobId: string) {
  if (!tryAcquireJobRun(jobId)) return;

  let job: StoredJob | undefined;
  try {
    job = await getJob(jobId);
    if (!job) return;
    if (job.migratedToQueue) {
      console.warn(`[run-job] skipping legacy runner for ${jobId} (migrated to normalized queue — use worker:queue)`);
      return;
    }
    if (job.status === "completed") return;
    if (job.status === "cancelled") return;
    if (job.status === "paused" && job.paused) {
      return;
    }

    const addresses = signerListForJob(job);
    const bundles: WalletBundle[] = [];

    const chainId = job.chainId ?? MAKALU_CHAIN_ID_DECIMAL;
    const chain = viemChainForChainId(chainId);
    const transport = httpTransportForChainId(chainId);

    for (const addr of addresses) {
      const pk = getOwnerWalletPrivateKey(job.owner, addr);
      if (!pk) {
        job.status = "failed";
        for (const r of job.results) {
          if (r.status === "queued" || r.status === "pending") {
            r.status = "failed";
            r.error =
              "No private key found for one of the selected distributor wallets. Add it again from wallet manager and retry.";
          }
        }
        await saveJob(job);
        return;
      }
      const account = privateKeyToAccount(pk);
      bundles.push({
        addressLower: account.address.toLowerCase(),
        account,
      });
    }

    const publicClient = createPublicClient({ chain, transport });

    let tokenDecimals = 18;
    if (job.mode === "erc20" && job.tokenAddress) {
      try {
        const d = await publicClient.readContract({
          address: job.tokenAddress as `0x${string}`,
          abi: erc20Abi,
          functionName: "decimals",
        });
        tokenDecimals = Number(d);
      } catch {
        tokenDecimals = 18;
      }
    }

    const rawT = Math.floor(Number(job.targetRunCount ?? 1));
    const target =
      Number.isFinite(rawT) && rawT >= 1 ? Math.min(MAX_JOB_TARGET_RUNS, rawT) : 1;

    {
      const latest = await getJob(jobId);
      if (!latest) return;
      if (latest.status === "cancelled") {
        job = latest;
        return;
      }
      if (latest.paused) {
        job = latest;
        job.status = "paused";
        job.paused = true;
        await saveJob(job);
        return;
      }
      job = latest;
    }

    /** Paused, claimed, or restart-recovered jobs resume at the stored pass. */
    const startRun = Math.max(1, Math.min(target, job.currentRun ?? 1));

    job.status = "running";
    job.paused = false;
    await saveJob(job);

    for (let run = startRun; run <= target; run++) {
      job.currentRun = run;
      await processRecipients(job, bundles, tokenDecimals);
      {
        const snap = await getJob(jobId);
        if (!snap) return;
        if (snap.status === "cancelled") return;
        job = snap;
      }
      if (job.paused) {
        job.status = "paused";
        await saveJob(job);
        return;
      }
      if (run < target) {
        job.currentRun = run + 1;
        for (const r of job.results) {
          r.status = "queued";
          r.error = undefined;
          r.txHash = undefined;
          r.signerAddress = undefined;
          r.rpcUrl = undefined;
        }
        job.status = "running";
        await saveJob(job);
      }
    }

    {
      const anyFail = job.results.some((r) => r.status === "failed");
      const allOk = job.results.every((r) => r.status === "success");
      if (allOk) job.status = "completed";
      else if (anyFail) job.status = "failed";
      else job.status = "completed";
    }
    await saveJob(job);
  } finally {
    releaseJobRun(jobId);
    try {
      const { triggerQueueTick } = await import("./job-queue");
      await triggerQueueTick();
    } catch (e) {
      console.error("[run-job] queue tick failed", e);
    }
    if (job) {
      try {
        await saveJob(job);
      } catch (e) {
        console.error("[run-job] final save failed", e);
      }
    }
  }
}

async function sendOneTransfer(
  job: StoredJob,
  r: BatchResult,
  wb: WalletBundle,
  tokenDecimals: number,
): Promise<void> {
  const { txHash, rpcUrl } = await executeEvmTransfer({
    mode: job.mode,
    tokenAddress: job.tokenAddress,
    chainId: job.chainId,
    owner: job.owner,
    signerAddress: wb.addressLower,
    recipient: r.recipient as `0x${string}`,
    amount: r.amount,
    tokenDecimals: job.mode === "erc20" ? tokenDecimals : undefined,
  });
  r.txHash = txHash;
  r.rpcUrl = rpcUrl;
  r.status = "success";
}

async function processRecipients(
  job: StoredJob,
  wallets: WalletBundle[],
  tokenDecimals: number,
) {
  if (wallets.length === 0) return;

  const pendingIndices = job.results
    .map((r, i) => (r.status !== "success" ? i : -1))
    .filter((i): i is number => i >= 0);

  for (let k = 0; k < pendingIndices.length; ) {
    const fromDb = await getJob(job.jobId);
    if (fromDb) {
      if (fromDb.status === "cancelled") {
        job.status = "cancelled";
        job.paused = true;
        await saveJob(job);
        return;
      }
      job.paused = fromDb.paused;
    }

    if (job.paused) {
      job.status = "paused";
      await saveJob(job);
      return;
    }

    const waveSize = Math.min(wallets.length, pendingIndices.length - k);
    const waveIndices = pendingIndices.slice(k, k + waveSize);

    for (let w = 0; w < waveIndices.length; w++) {
      const idx = waveIndices[w]!;
      const r = job.results[idx]!;
      r.status = "pending";
      r.error = undefined;
      r.txHash = undefined;
      r.rpcUrl = undefined;
      r.signerAddress = wallets[w]!.addressLower;
    }
    await saveJob(job);

    const parallel = maxParallelTxsPerWave();
    const chunkGap = interChunkDelayMs();
    for (let c = 0; c < waveIndices.length; c += parallel) {
      const end = Math.min(c + parallel, waveIndices.length);
      await Promise.all(
        waveIndices.slice(c, end).map(async (resultIndex, offset) => {
          const wIdx = c + offset;
          const r = job.results[resultIndex]!;
          const wb = wallets[wIdx]!;
          try {
            await sendOneTransfer(job, r, wb, tokenDecimals);
          } catch (e) {
            r.status = "failed";
            r.error = errMsg(e);
          }
        }),
      );
      if (end < waveIndices.length && chunkGap > 0) await sleep(chunkGap);
    }

    await saveJob(job);
    k += waveSize;
  }
}
