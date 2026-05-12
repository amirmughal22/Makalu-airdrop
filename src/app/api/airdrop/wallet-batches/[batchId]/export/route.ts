import { NextResponse } from "next/server";
import { exportGeneratedWalletsCsvChunk, getBatchForOwner } from "@/lib/generated-wallet-repo";
import { requireDistributorSession } from "@/lib/session";

const EXPORT_PAGE = 500;

/** CSV export — wallet_index and address only (private keys are not stored for generated batches). */
export async function GET(_request: Request, ctx: { params: Promise<{ batchId: string }> }) {
  const session = await requireDistributorSession(_request);
  if (session instanceof NextResponse) return session;
  const { batchId } = await ctx.params;
  const owner = session.address.toLowerCase();
  const batch = await getBatchForOwner(batchId, owner);
  if (!batch) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const rows: string[] = ["wallet_index,address"];

  let offset = 0;
  for (;;) {
    const chunk = await exportGeneratedWalletsCsvChunk({
      batchId,
      ownerLower: owner,
      limit: EXPORT_PAGE,
      offset,
    });
    if (!chunk.length) break;
    for (const r of chunk) {
      rows.push(`${r.wallet_index},${r.address}`);
    }
    offset += chunk.length;
    if (chunk.length < EXPORT_PAGE) break;
  }

  const body = rows.join("\n");
  const slug = batch.name.replace(/[^a-zA-Z0-9-_]+/g, "_").slice(0, 48) || "batch";
  const filename = `${slug}-${batchId}-addresses.csv`;
  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "X-Export-Contains-Private-Keys": "no",
    },
  });
}
