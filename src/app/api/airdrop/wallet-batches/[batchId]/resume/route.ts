import { NextResponse } from "next/server";
import { requeueInterruptedBatchForOwner } from "@/lib/generated-wallet-repo";
import { requireDistributorSession } from "@/lib/session";

/** Requeue a stuck `running` batch (partial progress) to `pending` so `npm run wallets:generate` picks it up immediately. */
export async function POST(_request: Request, ctx: { params: Promise<{ batchId: string }> }) {
  const session = await requireDistributorSession(_request);
  if (session instanceof NextResponse) return session;
  const { batchId } = await ctx.params;

  const result = await requeueInterruptedBatchForOwner(batchId, session.address.toLowerCase());
  if (!result.ok) {
    if (result.code === "not_found") {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json(
      {
        error:
          "Resume only applies to batches with status running and incomplete progress (inserted < total).",
      },
      { status: 400 },
    );
  }

  return NextResponse.json({
    ok: true,
    message:
      "Batch set to pending. Keep `npm run wallets:generate` running; it also auto-resumes incomplete running batches.",
  });
}
