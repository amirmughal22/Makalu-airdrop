import { NextResponse } from "next/server";
import { MAKALU_CHAIN_ID_DECIMAL, isSupportedChainId } from "@/lib/chain";
import { listDistributorWallets } from "@/lib/distributor-wallet-store";
import { getNativeBalancesForAddresses } from "@/lib/native-balances";
import { requireDistributorSession } from "@/lib/session";

/** Native LITHO balance per listed distributor wallet (on-demand; not included in main wallet list GET).
 *  Optional `addresses` (comma-separated): only those addresses are queried (must belong to the session).
 *  Omit `addresses` to fetch balances for every distributor wallet (backward compatible).
 */
export async function GET(request: Request) {
  const session = await requireDistributorSession(request);
  if (session instanceof NextResponse) return session;

  const url = new URL(request.url);
  const rawChain = parseInt(url.searchParams.get("chainId") ?? "", 10);
  const chainId = isSupportedChainId(rawChain) ? rawChain : MAKALU_CHAIN_ID_DECIMAL;

  const wallets = listDistributorWallets(session.address);
  const allowed = new Map(wallets.map((w) => [w.address.toLowerCase(), w]));

  const rawAddresses = url.searchParams.get("addresses");
  let targets: typeof wallets;
  if (rawAddresses !== null) {
    const requested = rawAddresses
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    targets = requested.map((k) => allowed.get(k)).filter((w): w is NonNullable<typeof w> => Boolean(w));
  } else {
    targets = wallets;
  }

  const map = await getNativeBalancesForAddresses(
    chainId,
    targets.map((w) => w.address),
  );

  const balances = targets.map((w) => {
    const b = map.get(w.address.toLowerCase());
    return {
      address: w.address,
      balanceNative: b?.display ?? "—",
      balanceWei: b?.wei ?? "0",
    };
  });

  return NextResponse.json({ chainId, balances });
}
