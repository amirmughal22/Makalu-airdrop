import { NextResponse } from "next/server";
import { decryptWalletField } from "@/lib/wallet-field-crypto";
import { exportGeneratedWalletsWithKeys, getBatchForOwner } from "@/lib/generated-wallet-repo";
import { requireDistributorSession } from "@/lib/session";

const EXPORT_PAGE = 500;

/** CSV export — addresses only unless `includePrivateKeys` confirmed (dangerous). */
export async function GET(request: Request, ctx: { params: Promise<{ batchId: string }> }) {
  const session = await requireDistributorSession(request);
  if (session instanceof NextResponse) return session;
  const { batchId } = await ctx.params;
  const owner = session.address.toLowerCase();
  const batch = await getBatchForOwner(batchId, owner);
  if (!batch) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const url = new URL(request.url);
  const includeKeys =
    url.searchParams.get("includePrivateKeys") === "1" && request.headers.get("x-export-private-keys") === "confirm";

  const rows: string[] = [];
  if (includeKeys) {
    rows.push("wallet_index,address,private_key");
  } else {
    rows.push("wallet_index,address");
  }

  let offset = 0;
  for (;;) {
    const chunk = await exportGeneratedWalletsWithKeys({
      batchId,
      ownerLower: owner,
      limit: EXPORT_PAGE,
      offset,
    });
    if (!chunk.length) break;
    for (const r of chunk) {
      if (includeKeys) {
        let pk: string;
        try {
          pk = decryptWalletField(r.private_key_encrypted);
        } catch {
          pk = "";
        }
        rows.push(`${r.wallet_index},${r.address},${pk}`);
      } else {
        rows.push(`${r.wallet_index},${r.address}`);
      }
    }
    offset += chunk.length;
    if (chunk.length < EXPORT_PAGE) break;
  }

  const body = rows.join("\n");
  const slug = batch.name.replace(/[^a-zA-Z0-9-_]+/g, "_").slice(0, 48) || "batch";
  const filename = includeKeys ? `${slug}-${batchId}-WITH-KEYS.csv` : `${slug}-${batchId}-addresses.csv`;
  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "X-Export-Contains-Private-Keys": includeKeys ? "yes" : "no",
    },
  });
}
