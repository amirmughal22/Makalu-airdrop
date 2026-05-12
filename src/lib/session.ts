import { NextResponse } from "next/server";
import { verifySessionToken } from "./auth";
import { getDistributorAddresses } from "./distributor";

export type AuthedSession = { address: string };

/** Valid JWT + server signing key must match the wallet you verified (same as MetaMask). */
export async function requireDistributorSession(request: Request): Promise<AuthedSession | NextResponse> {
  const auth = request.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) {
    return NextResponse.json({ error: "Missing session. Verify wallet first." }, { status: 401 });
  }
  const decoded = await verifySessionToken(auth.slice(7));
  if (!decoded) {
    return NextResponse.json({ error: "Invalid or expired session. Verify again." }, { status: 401 });
  }
  const serverAddrs = getDistributorAddresses();
  if (serverAddrs.length === 0) {
    return NextResponse.json(
      {
        error:
          "AIRDROP_PRIVATE_KEY is not set on the server. In Plesk → Node.js → Environment, add one or more private keys (0x…, 64 hex each). Multiple keys: comma-separated. Never commit keys.",
      },
      { status: 503 }
    );
  }
  const verified = decoded.address.toLowerCase();
  if (!serverAddrs.some((a) => a.toLowerCase() === verified)) {
    return NextResponse.json(
      {
        error:
          "Your verified wallet is not among the distributor keys on the server. Connect with a wallet whose key is in AIRDROP_PRIVATE_KEY, or add this account’s key (comma-separated if several).",
      },
      { status: 403 }
    );
  }
  return { address: decoded.address };
}
