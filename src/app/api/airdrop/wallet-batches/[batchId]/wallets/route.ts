import { NextResponse } from "next/server";
import { countGeneratedWalletsPage, listGeneratedWalletsPage } from "@/lib/generated-wallet-repo";
import { requireDistributorSession } from "@/lib/session";

const LIMIT_MAX = 100;
const DEFAULT_LIMIT = 50;

export async function GET(request: Request, ctx: { params: Promise<{ batchId: string }> }) {
  const session = await requireDistributorSession(request);
  if (session instanceof NextResponse) return session;
  const { batchId } = await ctx.params;
  const url = new URL(request.url);
  const page = Math.max(1, parseInt(url.searchParams.get("page") ?? "1", 10) || 1);
  const limit = Math.min(LIMIT_MAX, Math.max(1, parseInt(url.searchParams.get("limit") ?? String(DEFAULT_LIMIT), 10) || DEFAULT_LIMIT));
  const search = url.searchParams.get("q")?.trim() || undefined;
  const owner = session.address.toLowerCase();

  const offset = (page - 1) * limit;
  const [rows, total] = await Promise.all([
    listGeneratedWalletsPage({ batchId, ownerLower: owner, limit, offset, search }),
    countGeneratedWalletsPage({ batchId, ownerLower: owner, search }),
  ]);

  return NextResponse.json({
    wallets: rows.map((w) => ({
      id: w.id,
      walletIndex: w.wallet_index,
      address: w.address,
      createdAt: w.created_at instanceof Date ? w.created_at.toISOString() : String(w.created_at),
    })),
    page,
    limit,
    total,
  });
}
