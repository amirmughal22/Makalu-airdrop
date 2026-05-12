import { NextResponse } from "next/server";
import { generateChildWalletsFromEnvMnemonic } from "@/lib/distributor-wallet-store";
import { requireDistributorSession } from "@/lib/session";

export async function POST(request: Request) {
  const session = await requireDistributorSession(request);
  if (session instanceof NextResponse) return session;

  try {
    const body = (await request.json()) as { count?: number };
    const count = Math.floor(Number(body.count ?? 0));
    const { wallets, hdExport } = generateChildWalletsFromEnvMnemonic(session.address, count);
    return NextResponse.json({ wallets, hdExport });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Generation failed" }, { status: 400 });
  }
}
