import type { BatchResultSummary } from "./job-summary";
import type { StoredJob } from "./job-types";
import type { NormalizedJobListRow } from "./normalized-job-db";

function parseSignerAddressesJson(raw: unknown): string[] | undefined {
  if (raw == null) return undefined;
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (Array.isArray(parsed)) {
      const xs = parsed.filter((x): x is string => typeof x === "string").map((x) => x.toLowerCase());
      return xs.length ? xs : undefined;
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

function iso(d: Date | string | null | undefined): string | undefined {
  if (d == null) return undefined;
  const dt = d instanceof Date ? d : new Date(d);
  return Number.isFinite(dt.getTime()) ? dt.toISOString() : undefined;
}

/** Aggregate counts for UI — maps normalized wallet statuses into legacy summary shape. */
export function summaryFromNormalizedListRow(row: NormalizedJobListRow): BatchResultSummary {
  const total = Number(row.total_wallets ?? 0);
  const success = Number(row.processed_wallets ?? 0);
  const failed = Number(row.failed_wallets ?? 0);
  const pending = Number(row.pending_wallets ?? 0);
  const processing = Number(row.processing_wallets ?? 0);
  return {
    total,
    success,
    failed,
    pending,
    queued: 0,
    submitted: processing,
    activeWorkers: Number(row.active_workers ?? 0),
  };
}

export type JobProgressStats = {
  totalWallets: number;
  processedWallets: number;
  failedWallets: number;
  pendingWallets: number;
  processingWallets: number;
  progressPercent: number;
  activeWorkers: number;
  createdAt: string;
  updatedAt: string;
};

export function normalizedRowToProgressStats(row: NormalizedJobListRow): JobProgressStats {
  const total = Number(row.total_wallets ?? 0);
  const processed = Number(row.processed_wallets ?? 0);
  const failed = Number(row.failed_wallets ?? 0);
  const pending = Number(row.pending_wallets ?? 0);
  const processing = Number(row.processing_wallets ?? 0);
  const denom = total > 0 ? total : 1;
  const progressPercent = Math.min(100, Math.round(((processed + failed) / denom) * 100));
  return {
    totalWallets: total,
    processedWallets: processed,
    failedWallets: failed,
    pendingWallets: pending,
    processingWallets: processing,
    progressPercent,
    activeWorkers: Number(row.active_workers ?? 0),
    createdAt: iso(row.created_at) ?? new Date().toISOString(),
    updatedAt: iso(row.updated_at) ?? new Date().toISOString(),
  };
}

/** Minimal `StoredJob` for APIs — per-wallet rows are loaded via paginated wallets endpoint. */
export function normalizedListRowToStoredJob(row: NormalizedJobListRow): StoredJob {
  const signers = parseSignerAddressesJson(row.signer_addresses_json);
  const first = row.signer_address != null ? String(row.signer_address).toLowerCase() : signers?.[0];
  const status = String(row.status) as StoredJob["status"];
  return {
    jobId: String(row.id),
    owner: String(row.owner).toLowerCase(),
    signerAddress: first,
    signerAddresses: signers,
    status,
    mode: row.mode === "erc20" ? "erc20" : "native",
    tokenAddress: row.token_address != null ? String(row.token_address) : undefined,
    chainId: row.chain_id != null && Number(row.chain_id) > 0 ? Number(row.chain_id) : undefined,
    scheduledAt: iso(row.scheduled_at),
    queuedAt: iso(row.queued_at),
    createdAt: iso(row.created_at) ?? new Date().toISOString(),
    results: [],
    paused: Boolean(row.paused),
    targetRunCount: row.target_run_count != null ? Number(row.target_run_count) : 1,
    currentRun: row.current_run != null ? Number(row.current_run) : 1,
    loopForever: Boolean(row.loop_forever),
    migratedToQueue: true,
  };
}
