import { NextResponse } from "next/server";
import { requeueInterruptedBatchForOwner } from "@/lib/generated-wallet-repo";
import { startEmbeddedWalletGenerationIfEligible } from "@/lib/generated-wallet-embedded-lifecycle";
import { requireDistributorSession } from "@/lib/session";

/** Requeue a stuck `running` batch (partial progress) to `pending` so the generator picks it up (embedded loop or `npm run wallets:generate`). */
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

  startEmbeddedWalletGenerationIfEligible();

  return NextResponse.json({
    ok: true,
    message:
      "Batch set to pending. Embedded generation (if enabled) or `npm run wallets:generate` will resume materializing wallets.",
  });
}
