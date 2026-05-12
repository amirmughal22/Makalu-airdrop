import { NextResponse } from "next/server";
import { exportDistributorWalletsWithKeys } from "@/lib/distributor-wallet-store";
import { requireDistributorSession } from "@/lib/session";

/** Full backup of all distributor wallets (private keys) for re-import if JSON is lost. */
export async function GET(request: Request) {
  const session = await requireDistributorSession(request);
  if (session instanceof NextResponse) return session;

  const wallets = exportDistributorWalletsWithKeys(session.address);
  return NextResponse.json({
    exportedAt: new Date().toISOString(),
    warning: "This file contains private keys. Store offline only; do not share, email, or commit to version control.",
    walletCount: wallets.length,
    wallets,
  });
}
