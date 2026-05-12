import { NextResponse } from "next/server";
import { addDistributorWallet, listDistributorWallets, removeDistributorWallet } from "@/lib/distributor-wallet-store";
import { requireDistributorSession } from "@/lib/session";

export async function GET(request: Request) {
  const session = await requireDistributorSession(request);
  if (session instanceof NextResponse) return session;
  return NextResponse.json({ wallets: listDistributorWallets(session.address) });
}

export async function POST(request: Request) {
  const session = await requireDistributorSession(request);
  if (session instanceof NextResponse) return session;
  try {
    const body = (await request.json()) as { privateKey?: string; label?: string };
    const privateKey = typeof body.privateKey === "string" ? body.privateKey : "";
    const label = typeof body.label === "string" ? body.label : "";
    const wallet = addDistributorWallet(session.address, privateKey, label);
    return NextResponse.json({ wallet });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed to add wallet" }, { status: 400 });
  }
}

export async function DELETE(request: Request) {
  const session = await requireDistributorSession(request);
  if (session instanceof NextResponse) return session;
  try {
    const body = (await request.json()) as { address?: string };
    const address = typeof body.address === "string" ? body.address : "";
    removeDistributorWallet(session.address, address);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed to delete wallet" }, { status: 400 });
  }
}
