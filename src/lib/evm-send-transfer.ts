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

async function withRpcUrlFallback<T>(
  rpcUrls: string[],
  run: (transport: ReturnType<typeof http>) => Promise<T>,
): Promise<{ value: T; rpcUrl: string }> {
  const ordered = rankRpcUrlsByHealth(rpcUrls);
  let last: unknown;
  for (let i = 0; i < ordered.length; i++) {
    const rpcUrl = ordered[i]!;
    const transport = http(rpcUrl);
    const t0 = Date.now();
    try {
      const value = await withTransientRpcRetries(
        () => run(transport),
        ordered.length > 1 ? `via ${rpcUrl} (${i + 1}/${ordered.length})` : `via ${rpcUrl}`,
      );
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
    const receiptClient = createPublicClient({ chain, transport: http(rpcUrl) });
    const receipt = await withTransientRpcRetries(
      () => receiptClient.waitForTransactionReceipt({ hash }),
      `native receipt ${hash.slice(0, 12)}`,
    );
    if (receipt.status === "reverted") throw new Error("Transaction reverted");
    return { txHash: hash, rpcUrl };
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
  const receiptClient = createPublicClient({ chain, transport: http(rpcUrl) });
  const receipt = await withTransientRpcRetries(
    () => receiptClient.waitForTransactionReceipt({ hash }),
    `erc20 receipt ${hash.slice(0, 12)}`,
  );
  if (receipt.status === "reverted") throw new Error("Transaction reverted");
  return { txHash: hash, rpcUrl };
}
