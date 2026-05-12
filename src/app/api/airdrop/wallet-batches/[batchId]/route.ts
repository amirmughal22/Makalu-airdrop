import { NextResponse } from "next/server";
import { getBatchForOwner } from "@/lib/generated-wallet-repo";
import { requireDistributorSession } from "@/lib/session";

export async function GET(_request: Request, ctx: { params: Promise<{ batchId: string }> }) {
  const session = await requireDistributorSession(_request);
  if (session instanceof NextResponse) return session;
  const { batchId } = await ctx.params;
  const row = await getBatchForOwner(batchId, session.address.toLowerCase());
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json({
    batch: {
      id: row.id,
      name: row.name,
      totalWallets: row.total_wallets,
      insertedWallets: row.inserted_wallets,
      status: row.status,
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
      updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
      completedAt: row.completed_at
        ? row.completed_at instanceof Date
          ? row.completed_at.toISOString()
          : String(row.completed_at)
        : null,
      error: row.error,
      indexRange:
        row.total_wallets > 0
          ? { fromInclusive: 1, toInclusive: row.total_wallets, note: "1-based indices for job creation" }
          : null,
    },
  });
}
