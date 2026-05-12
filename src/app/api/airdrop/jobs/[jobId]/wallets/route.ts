import { NextResponse } from "next/server";
import { humanizeAirdropError } from "@/lib/humanize-airdrop-error";
import { getJob } from "@/lib/job-service";
import {
  countJobWalletsFiltered,
  listJobWalletsPage,
  type WalletPageRow,
} from "@/lib/normalized-job-db";
import { useNormalizedJobStorage } from "@/lib/normalized-job-config";
import { requireDistributorSession } from "@/lib/session";

type Params = { params: Promise<{ jobId: string }> };

const ALLOWED_STATUS = new Set(["pending", "processing", "completed", "failed"]);

function mapWalletRow(row: WalletPageRow) {
  const raw = String(row.status);
  const uiStatus =
    raw === "completed" ? "success" : raw === "processing" ? "submitted" : raw === "failed" ? "failed" : "pending";
  return {
    id: Number(row.id),
    recipient: row.wallet_address,
    amount: row.amount,
    status: uiStatus,
    rawStatus: raw,
    txHash: row.tx_hash ?? undefined,
    error: row.error_message ? humanizeAirdropError(row.error_message) : undefined,
    signerAddress: row.signer_address ?? undefined,
    rpcUrl: row.rpc_url ?? undefined,
    retryCount: row.retry_count,
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export async function GET(request: Request, { params }: Params) {
  const session = await requireDistributorSession(request);
  if (session instanceof NextResponse) return session;

  if (!useNormalizedJobStorage()) {
    return NextResponse.json(
      { error: "Paginated wallets API requires normalized job storage (DATABASE_URL + AIRDROP_NORMALIZED_JOBS)." },
      { status: 501 },
    );
  }

  const { jobId } = await params;
  const job = await getJob(jobId);
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });
  if (job.owner !== session.address.toLowerCase()) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const url = new URL(request.url);
  const limitRaw = parseInt(url.searchParams.get("limit") || "50", 10);
  const limit = Math.min(500, Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 50));
  const pageRaw = parseInt(url.searchParams.get("page") || "1", 10);
  const page = Math.max(1, Number.isFinite(pageRaw) ? pageRaw : 1);
  const offset = (page - 1) * limit;

  const cursorRaw = url.searchParams.get("cursor");
  const cursorId =
    cursorRaw != null && cursorRaw !== "" ? Math.max(0, parseInt(cursorRaw, 10)) : undefined;
  const parsedCursor = cursorId != null && Number.isFinite(cursorId) && cursorId > 0 ? cursorId : undefined;
  const useCursor = url.searchParams.get("useCursor") === "1" && parsedCursor != null;

  const statusRaw = url.searchParams.get("status")?.trim().toLowerCase();
  const status =
    statusRaw && ALLOWED_STATUS.has(statusRaw)
      ? (statusRaw as "pending" | "processing" | "completed" | "failed")
      : undefined;
  const search = url.searchParams.get("search")?.trim() || undefined;
  const txHash = url.searchParams.get("txHash")?.trim() || undefined;

  const filter = { jobId, status, search, txHash };
  const [{ rows, nextCursor }, totalMatching] = await Promise.all([
    listJobWalletsPage({
      jobId,
      limit,
      cursorId: useCursor ? parsedCursor : undefined,
      offset: useCursor ? undefined : offset,
      status,
      search,
      txHash,
    }),
    countJobWalletsFiltered(filter),
  ]);

  return NextResponse.json(
    {
      items: rows.map(mapWalletRow),
      nextCursor,
      page,
      totalMatching,
      totalPages: Math.max(1, Math.ceil(totalMatching / limit)),
      limit,
    },
    { headers: { "Cache-Control": "private, no-store, max-age=0" } },
  );
}
