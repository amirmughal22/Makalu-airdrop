import { NextResponse } from "next/server";
import { getFundTransferJobStats } from "@/lib/queue/fund-transfer-queue-repo";
import { requireDistributorSession } from "@/lib/session";

export async function GET(_request: Request, ctx: { params: Promise<{ jobId: string }> }) {
  const session = await requireDistributorSession(_request);
  if (session instanceof NextResponse) return session;
  const owner = session.address.toLowerCase();
  const { jobId } = await ctx.params;
  const stats = await getFundTransferJobStats(jobId, owner);
  if (!stats) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(stats);
}
