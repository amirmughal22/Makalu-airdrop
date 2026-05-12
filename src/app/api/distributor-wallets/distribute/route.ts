import { NextResponse } from "next/server";
import { createPublicClient, createWalletClient, isAddress, parseEther, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { MAKALU_CHAIN_ID_DECIMAL, httpTransportForChainId, isSupportedChainId, viemChainForChainId } from "@/lib/chain";
import { getOwnerWalletPrivateKey, isKnownDistributorAddress } from "@/lib/distributor-wallet-store";
import { erc20Abi } from "@/lib/erc20";
import { humanizeAirdropError } from "@/lib/humanize-airdrop-error";
import { requireDistributorSession } from "@/lib/session";
import { FUND_DISTRIBUTE_MAX_RECIPIENTS } from "@/lib/fund-distribute";
import { interChunkDelayMs, sleep, withTransientRpcRetries } from "@/lib/rpc-retry";

/** Allow long sequential funding runs (many txs + RPC retries). Platform must support it (e.g. Vercel `maxDuration`). */
export const maxDuration = 300;

/**
 * Send the same ERC-20 amount (or native LITHO) from one distributor wallet to many others in your list.
 * Recipients must already be registered distributor addresses for this account (sequential txs, same nonce account).
 */
export async function POST(request: Request) {
  const session = await requireDistributorSession(request);
  if (session instanceof NextResponse) return session;
  const owner = session.address.toLowerCase();

  try {
    const body = (await request.json()) as {
      chainId?: number;
      mode?: "erc20" | "native";
      fromAddress?: string;
      tokenAddress?: string;
      amountPerWallet?: string;
      toAddresses?: string[];
    };

    const mode = body.mode === "native" ? "native" : "erc20";
    const chainIdRaw = Number(body.chainId ?? MAKALU_CHAIN_ID_DECIMAL);
    if (!isSupportedChainId(chainIdRaw)) {
      return NextResponse.json({ error: "Unsupported chainId." }, { status: 400 });
    }
    const chainId = chainIdRaw;
    const fromAddress = String(body.fromAddress || "").trim().toLowerCase();
    const amountStr = String(body.amountPerWallet || "").trim();
    const toAddresses = Array.isArray(body.toAddresses)
      ? [...new Set(body.toAddresses.map((a) => String(a || "").trim().toLowerCase()).filter(Boolean))]
      : [];

    if (!fromAddress || !isAddress(fromAddress)) {
      return NextResponse.json({ error: "fromAddress is required." }, { status: 400 });
    }
    if (!getOwnerWalletPrivateKey(owner, fromAddress)) {
      return NextResponse.json({ error: "fromAddress is not a wallet you control on this server." }, { status: 403 });
    }
    if (!amountStr || Number(amountStr) <= 0) {
      return NextResponse.json({ error: "amountPerWallet must be a positive number." }, { status: 400 });
    }
    if (toAddresses.length === 0) {
      return NextResponse.json({ error: "Select at least one recipient wallet." }, { status: 400 });
    }
    if (toAddresses.length > FUND_DISTRIBUTE_MAX_RECIPIENTS) {
      return NextResponse.json(
        { error: `At most ${FUND_DISTRIBUTE_MAX_RECIPIENTS} recipients per request.` },
        { status: 400 },
      );
    }

    let tokenAddress: `0x${string}` | undefined;
    if (mode === "erc20") {
      const ta = String(body.tokenAddress || "").trim().toLowerCase();
      if (!ta || !isAddress(ta)) {
        return NextResponse.json({ error: "tokenAddress is required for ERC-20 mode." }, { status: 400 });
      }
      tokenAddress = ta as `0x${string}`;
    }

    for (const t of toAddresses) {
      if (!isAddress(t)) return NextResponse.json({ error: `Invalid recipient: ${t}` }, { status: 400 });
      if (!isKnownDistributorAddress(owner, t)) {
        return NextResponse.json({ error: `Recipient ${t} is not in your distributor list.` }, { status: 400 });
      }
      if (t === fromAddress) {
        return NextResponse.json({ error: "Cannot send to the same address as fromAddress." }, { status: 400 });
      }
    }

    const pk = getOwnerWalletPrivateKey(owner, fromAddress)!;
    const account = privateKeyToAccount(pk);
    const chain = viemChainForChainId(chainId);
    const transport = httpTransportForChainId(chainId);
    const walletClient = createWalletClient({ account, chain, transport });
    const publicClient = createPublicClient({ chain, transport });

    let decimals = 18;
    let amountWei: bigint;
    if (mode === "erc20" && tokenAddress) {
      try {
        const d = await publicClient.readContract({
          address: tokenAddress,
          abi: erc20Abi,
          functionName: "decimals",
        });
        decimals = Number(d);
        if (!Number.isFinite(decimals) || decimals < 0 || decimals > 36) decimals = 18;
      } catch {
        decimals = 18;
      }
      amountWei = parseUnits(amountStr, decimals);
    } else {
      amountWei = parseEther(amountStr);
    }

    const results: { to: string; txHash?: string; error?: string }[] = [];
    const gap = interChunkDelayMs();

    for (let i = 0; i < toAddresses.length; i++) {
      const to = toAddresses[i]!;
      try {
        const hash =
          mode === "native"
            ? await withTransientRpcRetries(
                () =>
                  walletClient.sendTransaction({
                    to: to as `0x${string}`,
                    value: amountWei,
                  }),
                `distribute native ${to.slice(0, 10)}`,
              )
            : await withTransientRpcRetries(
                () =>
                  walletClient.writeContract({
                    address: tokenAddress!,
                    abi: erc20Abi,
                    functionName: "transfer",
                    args: [to as `0x${string}`, amountWei],
                  }),
                `distribute erc20 ${to.slice(0, 10)}`,
              );
        results.push({ to, txHash: hash });
      } catch (e) {
        results.push({ to, error: humanizeAirdropError(e) });
      }
      if (i < toAddresses.length - 1 && gap > 0) await sleep(gap);
    }

    const allOk = results.every((r) => Boolean(r.txHash));
    return NextResponse.json({ results, allOk });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Distribute failed" }, { status: 400 });
  }
}
