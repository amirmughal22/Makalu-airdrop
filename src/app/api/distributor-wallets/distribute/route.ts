import { NextResponse } from "next/server";
import { isAddress } from "viem";
import { MAKALU_CHAIN_ID_DECIMAL, isSupportedChainId } from "@/lib/chain";
import { getOwnerWalletPrivateKey, isKnownDistributorAddress } from "@/lib/distributor-wallet-store";
import { humanizeAirdropError } from "@/lib/humanize-airdrop-error";
import { requireDistributorSession } from "@/lib/session";
import { FUND_DISTRIBUTE_MAX_RECIPIENTS } from "@/lib/fund-distribute";
import { interChunkDelayMs, sleep } from "@/lib/rpc-retry";
import { executeEvmTransfer } from "@/lib/transfers/fund-transfer-service";

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

    let tokenAddress: `0x${string}` | null = null;
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

    const results: { to: string; txHash?: string; error?: string }[] = [];
    const gap = interChunkDelayMs();

    for (let i = 0; i < toAddresses.length; i++) {
      const to = toAddresses[i]!;
      try {
        const { txHash } = await executeEvmTransfer({
          mode,
          tokenAddress: mode === "erc20" ? tokenAddress : null,
          chainId,
          owner,
          signerAddress: fromAddress,
          recipient: to as `0x${string}`,
          amount: amountStr,
        });
        results.push({ to, txHash });
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
