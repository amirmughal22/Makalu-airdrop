import { NextResponse } from "next/server";
import { MAKALU_CHAIN_ID_DECIMAL, isSupportedChainId } from "@/lib/chain";
import { getOwnerWalletPrivateKey } from "@/lib/distributor-wallet-store";
import { requireDistributorSession } from "@/lib/session";
import {
  countFundTransferJobsForOwner,
  createFundTransferJobFromBatchRange,
  listFundTransferJobsForOwner,
} from "@/lib/queue/fund-transfer-queue-repo";

const PAGE_SIZE = 20;

export async function GET(request: Request) {
  const session = await requireDistributorSession(request);
  if (session instanceof NextResponse) return session;
  const owner = session.address.toLowerCase();
  const url = new URL(request.url);
  const page = Math.max(1, parseInt(url.searchParams.get("page") ?? "1", 10) || 1);
  const offset = (page - 1) * PAGE_SIZE;
  const total = await countFundTransferJobsForOwner(owner);
  const jobs = await listFundTransferJobsForOwner(owner, PAGE_SIZE, offset);
  return NextResponse.json({
    jobs: jobs.map((j) => ({
      id: j.id,
      name: j.name,
      batchId: j.generated_batch_id,
      fromWalletIndex: j.from_wallet_index,
      toWalletIndex: j.to_wallet_index,
      amountPerWallet: j.amount_per_wallet,
      signerAddress: j.signer_address,
      mode: j.mode,
      chainId: j.chain_id,
      totalRows: j.total_rows,
      createdAt: j.created_at instanceof Date ? j.created_at.toISOString() : String(j.created_at),
    })),
    page,
    pageSize: PAGE_SIZE,
    total,
  });
}

export async function POST(request: Request) {
  const session = await requireDistributorSession(request);
  if (session instanceof NextResponse) return session;
  const owner = session.address.toLowerCase();

  try {
    const body = (await request.json()) as {
      batchId?: string;
      fromWalletIndex?: number;
      toWalletIndex?: number;
      amountPerWallet?: string;
      signerAddress?: string;
      mode?: "native" | "erc20";
      tokenAddress?: string | null;
      chainId?: number;
      name?: string | null;
    };

    const batchId = String(body.batchId || "").trim();
    if (!batchId) return NextResponse.json({ error: "batchId is required" }, { status: 400 });

    const chainIdRaw = Number(body.chainId ?? MAKALU_CHAIN_ID_DECIMAL);
    if (!isSupportedChainId(chainIdRaw)) {
      return NextResponse.json({ error: "Unsupported chainId." }, { status: 400 });
    }

    const signer = String(body.signerAddress || "").trim().toLowerCase();
    if (!signer.startsWith("0x")) {
      return NextResponse.json({ error: "signerAddress is required" }, { status: 400 });
    }
    if (!getOwnerWalletPrivateKey(owner, signer)) {
      return NextResponse.json({ error: "Signer is not a registered distributor wallet with a stored key." }, { status: 403 });
    }

    const mode = body.mode === "native" ? "native" : "erc20";
    const { jobId, rowsInserted } = await createFundTransferJobFromBatchRange({
      ownerLower: owner,
      name: body.name ?? null,
      batchId,
      fromWalletIndex: Number(body.fromWalletIndex),
      toWalletIndex: Number(body.toWalletIndex),
      amountPerWallet: String(body.amountPerWallet ?? ""),
      signerAddress: signer,
      mode,
      tokenAddress: body.tokenAddress ?? null,
      chainId: chainIdRaw,
    });

    return NextResponse.json({
      jobId,
      rowsInserted,
      message:
        "Transfer rows created. PM2 queue workers will claim and execute sends (not this API request).",
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed to create fund transfer job" }, { status: 400 });
  }
}
