/** Upper bound for full passes / `currentRun` (MySQL `INT` max; effectively unlimited in practice). */
export const MAX_JOB_TARGET_RUNS = 2_147_483_647;

export type BatchResult = {
  recipient: string;
  amount: string;
  txHash?: string;
  status: "queued" | "submitted" | "success" | "failed" | "pending";
  error?: string;
  /** Which distributor wallet sent this transfer (multi-wallet jobs). */
  signerAddress?: string;
  /** JSON-RPC URL that successfully broadcast this tx (when known). */
  rpcUrl?: string;
};

export type StoredJob = {
  jobId: string;
  owner: string;
  signerAddress?: string;
  /** When set, each wave runs up to one tx per wallet in parallel (round-robin across recipients). */
  signerAddresses?: string[];
  status: "draft" | "queued" | "running" | "paused" | "completed" | "failed" | "cancelled";
  mode: "native" | "erc20";
  tokenAddress?: string;
  /** Lithosphere Makalu 700777; omitted on older jobs → treated as Makalu */
  chainId?: number;
  scheduledAt?: string;
  queuedAt?: string;
  createdAt: string;
  results: BatchResult[];
  paused: boolean;
  /** How many full passes to execute (same recipients, same amounts). Default 1. Legacy file/JSON jobs only. */
  targetRunCount?: number;
  /** Normalized queue: when true, job auto re-queues after each cycle until paused or cancelled. */
  loopForever?: boolean;
  /** 1-based index of the pass currently in progress. */
  currentRun?: number;
  /** Prevents overlapping runners */
  _runnerActive?: boolean;
  /** Recipients copied to normalized `job_wallets`; legacy JSON runner skips execution. */
  migratedToQueue?: boolean;
};

export type RecipientInput = {
  id: string;
  address: string;
  amount: string;
  source?: string;
};
