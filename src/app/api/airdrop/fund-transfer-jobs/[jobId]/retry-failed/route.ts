import { NextResponse } from "next/server";
import { adminRetryFailedFundTransfers } from "@/lib/queue/fund-transfer-queue-repo";
import { requireDistributorSession } from "@/lib/session";

export async function POST(request: Request, ctx: { params: Promise<{ jobId: string }> }) {
  const session = await requireDistributorSession(request);
  if (session instanceof NextResponse) return session;
  const owner = session.address.toLowerCase();
  const { jobId } = await ctx.params;
  const n = await adminRetryFailedFundTransfers(jobId, owner);
  return NextResponse.json({ resetRows: n });
}
