import { NextResponse } from "next/server";
import { countBatchesForOwner, insertPendingBatch, listBatchesForOwner } from "@/lib/generated-wallet-repo";
import { walletGenerationMaxWallets } from "@/lib/generated-wallet-config";
import { requireDistributorSession } from "@/lib/session";

const PAGE_SIZE = 30;

export async function GET(request: Request) {
  const session = await requireDistributorSession(request);
  if (session instanceof NextResponse) return session;

  const url = new URL(request.url);
  const page = Math.max(1, parseInt(url.searchParams.get("page") ?? "1", 10) || 1);
  const owner = session.address.toLowerCase();
  const total = await countBatchesForOwner(owner);
  const offset = (page - 1) * PAGE_SIZE;
  const batches = await listBatchesForOwner(owner, PAGE_SIZE, offset);

  return NextResponse.json({
    batches: batches.map((b) => ({
      id: b.id,
      name: b.name,
      totalWallets: b.total_wallets,
      insertedWallets: b.inserted_wallets,
      status: b.status,
      createdAt: b.created_at instanceof Date ? b.created_at.toISOString() : String(b.created_at),
      updatedAt: b.updated_at instanceof Date ? b.updated_at.toISOString() : String(b.updated_at),
      completedAt: b.completed_at ? (b.completed_at instanceof Date ? b.completed_at.toISOString() : String(b.completed_at)) : null,
      error: b.error,
    })),
    page,
    pageSize: PAGE_SIZE,
    total,
  });
}

export async function POST(request: Request) {
  const session = await requireDistributorSession(request);
  if (session instanceof NextResponse) return session;

  try {
    const body = (await request.json()) as { name?: string; totalWallets?: number };
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) return NextResponse.json({ error: "Batch name is required" }, { status: 400 });
    const n = Math.floor(Number(body.totalWallets));
    if (!Number.isFinite(n) || n < 1) {
      return NextResponse.json({ error: "totalWallets must be a positive integer" }, { status: 400 });
    }
    const max = walletGenerationMaxWallets();
    if (n > max) {
      return NextResponse.json({ error: `totalWallets exceeds limit (${max.toLocaleString("en-US")})` }, { status: 400 });
    }

    const id = await insertPendingBatch(session.address.toLowerCase(), name, n);
    return NextResponse.json({
      batchId: id,
      message:
        "Batch created with status pending. Run `npm run wallets:generate` (or a dedicated worker) to materialize wallets.",
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to create batch" },
      { status: 400 },
    );
  }
}
