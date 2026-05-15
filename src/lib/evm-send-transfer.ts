import {
  createPublicClient,
  createWalletClient,
  http,
  parseEther,
  parseUnits,
  type Chain,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  MAKALU_CHAIN_ID_DECIMAL,
  rpcHttpUrlsForChainId,
  viemChainForChainId,
} from "./chain";
import { rankRpcUrlsByHealth, recordRpcRoundTrip } from "./rpc-health";
import { erc20Abi } from "./erc20";
import { getOwnerWalletPrivateKey } from "./distributor-wallet-store";
import { withTransientRpcRetries } from "./rpc-retry";

function envInt(name: string, fallback: number, min: number, max: number): number {
  const n = parseInt(process.env[name]?.trim() ?? "", 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function envBool(name: string, fallback: boolean): boolean {
  const v = process.env[name]?.trim().toLowerCase();
  if (!v) return fallback;
  if (v === "0" || v === "false" || v === "no") return false;
  if (v === "1" || v === "true" || v === "yes") return true;
  return fallback;
}

function rpcHttpTimeoutMs(): number {
  return envInt("AIRDROP_RPC_HTTP_TIMEOUT_MS", 30_000, 1000, 120_000);
}

function receiptTimeoutMs(): number {
  return envInt("AIRDROP_TX_RECEIPT_TIMEOUT_MS", 180_000, 10_000, 3_600_000);
}

function receiptPollingIntervalMs(): number {
  return envInt("AIRDROP_TX_RECEIPT_POLL_MS", 2_000, 250, 60_000);
}

function waitForReceiptEnabled(): boolean {
  return envBool("AIRDROP_TX_WAIT_FOR_RECEIPT", true);
}

function rpcTransport(rpcUrl: string): ReturnType<typeof http> {
  return http(rpcUrl, { timeout: rpcHttpTimeoutMs() });
}

async function withRpcUrlFallback<T>(
  rpcUrls: string[],
  run: (transport: ReturnType<typeof http>) => Promise<T>,
  opts?: { retryTransient?: boolean; label?: string },
): Promise<{ value: T; rpcUrl: string }> {
  const ordered = rankRpcUrlsByHealth(rpcUrls);
  let last: unknown;
  for (let i = 0; i < ordered.length; i++) {
    const rpcUrl = ordered[i]!;
    const transport = rpcTransport(rpcUrl);
    const t0 = Date.now();
    try {
      const label = opts?.label ?? (ordered.length > 1 ? `via ${rpcUrl} (${i + 1}/${ordered.length})` : `via ${rpcUrl}`);
      const value = opts?.retryTransient === false ? await run(transport) : await withTransientRpcRetries(() => run(transport), label);
      recordRpcRoundTrip(rpcUrl, Date.now() - t0, true);
      return { value, rpcUrl };
    } catch (e) {
      recordRpcRoundTrip(rpcUrl, Date.now() - t0, false);
      last = e;
      if (i < ordered.length - 1) {
        console.warn(`[evm-send-transfer] RPC exhausted for ${rpcUrl}, trying next`, e);
        continue;
      }
      throw e;
    }
  }
  throw last;
}

async function waitForTransferReceipt(opts: {
  hash: `0x${string}`;
  chain: Chain;
  rpcUrls: string[];
  submittedRpcUrl: string;
  label: string;
}): Promise<string> {
  if (!waitForReceiptEnabled()) {
    console.warn(`[evm-send-transfer] ${opts.label} submitted ${opts.hash}; AIRDROP_TX_WAIT_FOR_RECEIPT=false so marking submitted hash as success`);
    return opts.submittedRpcUrl;
  }

  const { value: receipt, rpcUrl } = await withRpcUrlFallback(
    opts.rpcUrls,
    (transport) => {
      const receiptClient = createPublicClient({ chain: opts.chain, transport });
      return receiptClient.waitForTransactionReceipt({
        hash: opts.hash,
        timeout: receiptTimeoutMs(),
        pollingInterval: receiptPollingIntervalMs(),
      });
    },
    { retryTransient: false, label: `${opts.label} receipt ${opts.hash.slice(0, 12)}` },
  );
  if (receipt.status === "reverted") throw new Error("Transaction reverted");
  return rpcUrl;
}

export async function readErc20Decimals(tokenAddress: `0x${string}`, chainId: number): Promise<number> {
  const chain = viemChainForChainId(chainId);
  const rpcUrls = rpcHttpUrlsForChainId(chainId);
  const { value: decimals, rpcUrl } = await withRpcUrlFallback(rpcUrls, (transport) => {
    const publicClient = createPublicClient({ chain, transport });
    return publicClient.readContract({
      address: tokenAddress,
      abi: erc20Abi,
      functionName: "decimals",
    });
  });
  void rpcUrl;
  return Number(decimals);
}

export async function executeEvmTransfer(opts: {
  mode: "native" | "erc20";
  tokenAddress?: string | null;
  chainId?: number | null;
  owner: string;
  signerAddress: string;
  recipient: `0x${string}`;
  amount: string;
  /** When omitted for ERC-20, decimals are read from the contract (extra RPC). */
  tokenDecimals?: number;
}): Promise<{ txHash: `0x${string}`; rpcUrl: string }> {
  const chainId = opts.chainId ?? MAKALU_CHAIN_ID_DECIMAL;
  const chain = viemChainForChainId(chainId) as Chain;
  const rpcUrls = rpcHttpUrlsForChainId(chainId);
  const pk = getOwnerWalletPrivateKey(opts.owner.toLowerCase(), opts.signerAddress.toLowerCase());
  if (!pk) {
    throw new Error(
      "No private key found for the selected distributor wallet. Add it again from wallet manager and retry.",
    );
  }
  const account = privateKeyToAccount(pk);

  if (opts.mode === "native") {
    const { value: hash, rpcUrl } = await withRpcUrlFallback(rpcUrls, (transport) => {
      const walletClient = createWalletClient({ account, chain, transport });
      return walletClient.sendTransaction({
        account,
        chain,
        to: opts.recipient,
        value: parseEther(opts.amount),
      });
    });
    const receiptRpcUrl = await waitForTransferReceipt({
      hash,
      chain,
      rpcUrls,
      submittedRpcUrl: rpcUrl,
      label: "native",
    });
    return { txHash: hash, rpcUrl: receiptRpcUrl };
  }

  if (!opts.tokenAddress) throw new Error("Missing token address");
  const token = opts.tokenAddress as `0x${string}`;
  let tokenDecimals = opts.tokenDecimals;
  if (tokenDecimals == null) {
    try {
      tokenDecimals = await readErc20Decimals(token, chainId);
    } catch {
      tokenDecimals = 18;
    }
  }
  const value = parseUnits(opts.amount, tokenDecimals);
  const { value: hash, rpcUrl } = await withRpcUrlFallback(rpcUrls, (transport) => {
    const walletClient = createWalletClient({ account, chain, transport });
    return walletClient.writeContract({
      account,
      chain,
      address: token,
      abi: erc20Abi,
      functionName: "transfer",
      args: [opts.recipient, value],
    });
  });
  const receiptRpcUrl = await waitForTransferReceipt({
    hash,
    chain,
    rpcUrls,
    submittedRpcUrl: rpcUrl,
    label: "erc20",
  });
  return { txHash: hash, rpcUrl: receiptRpcUrl };
}
