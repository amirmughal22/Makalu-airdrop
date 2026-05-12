import { createPublicClient, formatEther, isAddress } from "viem";
import { httpTransportForChainId, viemChainForChainId } from "./chain";
import { sleep } from "./rpc-retry";

/** Human-readable LITHO (18 decimals) for UI — trims noise for tiny/large values. */
export function formatNativeBalanceDisplay(wei: bigint): string {
  const s = formatEther(wei);
  const n = Number(s);
  if (!Number.isFinite(n)) return s;
  if (n === 0) return "0";
  if (Math.abs(n) >= 1_000_000) return `${n.toExponential(4)}`;
  if (Math.abs(n) < 0.0001 && n !== 0) return "<0.0001";
  return String(parseFloat(n.toPrecision(10)));
}

function balanceRpcGapMs(): number {
  const n = parseInt(process.env.AIRDROP_BALANCE_RPC_GAP_MS?.trim() ?? "", 10);
  if (!Number.isFinite(n)) return 120;
  return Math.min(5000, Math.max(0, n));
}

/** Fetches native balance per address on `chainId` (sequential + small gap to avoid gateway timeouts). */
export async function getNativeBalancesForAddresses(
  chainId: number,
  addresses: string[],
): Promise<Map<string, { display: string; wei: string }>> {
  const chain = viemChainForChainId(chainId);
  const transport = httpTransportForChainId(chainId);
  const publicClient = createPublicClient({ chain, transport });
  const out = new Map<string, { display: string; wei: string }>();
  const gap = balanceRpcGapMs();

  for (let i = 0; i < addresses.length; i++) {
    const raw = addresses[i]!;
    const addr = raw.trim();
    const key = addr.toLowerCase();
    if (!isAddress(addr)) {
      out.set(key, { display: "—", wei: "0" });
    } else {
      try {
        const wei = await publicClient.getBalance({ address: addr as `0x${string}` });
        out.set(key, { display: formatNativeBalanceDisplay(wei), wei: wei.toString() });
      } catch {
        out.set(key, { display: "—", wei: "0" });
      }
    }
    if (gap > 0 && i < addresses.length - 1) await sleep(gap);
  }
  return out;
}
