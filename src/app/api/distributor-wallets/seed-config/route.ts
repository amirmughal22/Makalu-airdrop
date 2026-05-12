import { NextResponse } from "next/server";
import { isHdMnemonicConfigured } from "@/lib/distributor-wallet-store";
import { requireDistributorSession } from "@/lib/session";

/** Whether the server has `AIRDROP_HD_MNEMONIC` set (never returns the phrase). */
export async function GET(request: Request) {
  const session = await requireDistributorSession(request);
  if (session instanceof NextResponse) return session;
  return NextResponse.json({ hdSeedConfigured: isHdMnemonicConfigured() });
}
