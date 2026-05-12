export type NormalizedJobWalletStatus = "pending" | "processing" | "completed" | "failed";

export type NormalizedJobRow = {
  id: string;
  owner: string;
  name: string | null;
  status: string;
  totalWallets: number;
  processedWallets: number;
  failedWallets: number;
  mode: "native" | "erc20";
  tokenAddress: string | null;
  chainId: number | null;
  paused: boolean;
  scheduledAt: string | null;
  queuedAt: string | null;
  targetRunCount: number;
  currentRun: number;
  /** Server-driven continuous rerun after each cycle (normalized queue). */
  loopForever: boolean;
  signerAddress: string | null;
  signerAddresses: string[] | null;
  createdAt: string;
  updatedAt: string;
};

export type ClaimedWalletRow = {
  id: number;
  jobId: string;
  walletAddress: string;
  amount: string;
  retryCount: number;
  signerAddress: string | null;
  owner: string;
  mode: "native" | "erc20";
  tokenAddress: string | null;
  chainId: number | null;
};
