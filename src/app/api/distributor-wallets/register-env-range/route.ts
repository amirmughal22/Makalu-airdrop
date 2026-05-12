import { NextResponse } from "next/server";
import { registerEnvSeedIndexRange } from "@/lib/distributor-wallet-store";
import { requireDistributorSession } from "@/lib/session";

/** Bulk-register indices from `AIRDROP_HD_MNEMONIC` (same derivation as generate-from-seed). Body: { startIndex?, count } */
export async function POST(request: Request) {
  const session = await requireDistributorSession(request);
  if (session instanceof NextResponse) return session;

  try {
    const body = (await request.json()) as { startIndex?: number; count?: number };
    const startIndex = body.startIndex !== undefined ? Number(body.startIndex) : 0;
    const count = body.count !== undefined ? Number(body.count) : 0;
    const result = registerEnvSeedIndexRange(session.address, startIndex, count);
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Registration failed" }, { status: 400 });
  }
}
