import { NextResponse } from "next/server";
import { addDistributorWallet } from "@/lib/distributor-wallet-store";
import { requireDistributorSession } from "@/lib/session";

const MAX_WALLETS = 200;

type Row = { privateKey: string; label: string };

function extractRows(body: unknown): Row[] {
  if (!body || typeof body !== "object") return [];
  const o = body as Record<string, unknown>;
  let arr: unknown[] = [];
  if (Array.isArray(o.wallets)) arr = o.wallets;
  else if (Array.isArray(body)) arr = body as unknown[];

  const out: Row[] = [];
  let i = 0;
  for (const item of arr) {
    i += 1;
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const privateKey = typeof r.privateKey === "string" ? r.privateKey.trim() : "";
    if (!privateKey) continue;
    let label = typeof r.label === "string" ? r.label.trim().slice(0, 60) : "";
    if (!label) label = `Imported ${i}`;
    out.push({ privateKey, label });
  }
  return out;
}

/**
 * Bulk-import distributor wallets from JSON (e.g. HD "Download keys" export, or `[{ privateKey, label }]`)
 */
export async function POST(request: Request) {
  const session = await requireDistributorSession(request);
  if (session instanceof NextResponse) return session;

  try {
    const body: unknown = await request.json();
    const rows = extractRows(body);
    if (rows.length === 0) {
      return NextResponse.json(
        { error: 'No valid entries found. Expected a "wallets" array with objects containing "privateKey".' },
        { status: 400 },
      );
    }
    if (rows.length > MAX_WALLETS) {
      return NextResponse.json({ error: `At most ${MAX_WALLETS} wallets per import.` }, { status: 400 });
    }

    const results: Array<{
      address?: string;
      label: string;
      status: "added" | "skipped";
      reason?: string;
    }> = [];

    for (const { privateKey, label } of rows) {
      try {
        const w = addDistributorWallet(session.address, privateKey, label);
        results.push({ address: w.address, label: w.label, status: "added" });
      } catch (e) {
        const reason = e instanceof Error ? e.message : "Failed";
        results.push({ label, status: "skipped", reason });
      }
    }

    const added = results.filter((r) => r.status === "added").length;
    const skipped = results.length - added;
    return NextResponse.json({ added, skipped, results });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Invalid JSON or import failed" },
      { status: 400 },
    );
  }
}
