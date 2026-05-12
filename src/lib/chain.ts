import { defineChain, fallback, http } from "viem";

const DEFAULT_CHAIN_ID = 700777;
const DEFAULT_CHAIN_NAME = "Lithosphere Makalu";
const DEFAULT_EXPLORER_URL = "https://makalu.litho.ai";

const DEFAULT_MAKALU_RPCS = ["https://rpc-2.litho.ai", "https://rpc.litho.ai"] as const;

function splitEnvUrls(s: string | undefined): string[] | null {
  if (s == null || !s.trim()) return null;
  const parts = s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  return parts.length ? parts : null;
}

/**
 * Decimal chain ID — `NEXT_PUBLIC_CHAIN_ID` only (read by API routes and browser bundle).
 * Default 700777 (Makalu).
 */
function readEnvChainId(): number {
  const raw = process.env.NEXT_PUBLIC_CHAIN_ID?.trim();
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_CHAIN_ID;
}

/** Human-readable network name for UI and wallet_addEthereumChain. */
export function resolvedChainName(): string {
  return process.env.NEXT_PUBLIC_CHAIN_NAME?.trim() || DEFAULT_CHAIN_NAME;
}

function resolvedExplorerUrl(): string {
  return process.env.NEXT_PUBLIC_EXPLORER_URL?.trim() || DEFAULT_EXPLORER_URL;
}

function resolvedBlockExplorerLabel(): string {
  const explicit = process.env.NEXT_PUBLIC_BLOCK_EXPLORER_NAME?.trim();
  if (explicit) return explicit;
  const name = resolvedChainName();
  const first = name.split(/\s+/)[0]?.trim();
  return first || "Explorer";
}

function resolvedNativeCurrency() {
  const name = process.env.NEXT_PUBLIC_NATIVE_CURRENCY_NAME?.trim() || "LITHO";
  const symbol = process.env.NEXT_PUBLIC_NATIVE_CURRENCY_SYMBOL?.trim() || "LITHO";
  const decRaw = process.env.NEXT_PUBLIC_NATIVE_CURRENCY_DECIMALS?.trim() || "18";
  const decimals = Math.min(77, Math.max(0, parseInt(decRaw, 10) || 18));
  return { name, symbol, decimals };
}

/** Active chain ID for this deployment (from env). */
export const MAKALU_CHAIN_ID_DECIMAL = readEnvChainId();

/** Ordered JSON-RPC endpoints — `NEXT_PUBLIC_RPC_URL` or `NEXT_PUBLIC_RPC_URLS` only (server + client). */
export const MAKALU_RPC_URL_LIST: string[] = (() => {
  const single = process.env.NEXT_PUBLIC_RPC_URL?.trim();
  if (single) return [single];
  const multi = splitEnvUrls(process.env.NEXT_PUBLIC_RPC_URLS);
  if (multi) return multi;
  return [...DEFAULT_MAKALU_RPCS];
})();

/** Primary RPC (first in {@link MAKALU_RPC_URL_LIST}) — wallet/UI hints. */
export const MAKALU_RPC_URL = MAKALU_RPC_URL_LIST[0]!;

/** REST / GraphQL API base (optional integrations) — `NEXT_PUBLIC_MAKALU_API_URL` only. */
export const MAKALU_API_URL = process.env.NEXT_PUBLIC_MAKALU_API_URL?.trim() ?? "https://api-2.litho.ai";

export const EXPLORER_URL = resolvedExplorerUrl();

/** @deprecated Prefer MAKALU_CHAIN_ID_DECIMAL */
export const CHAIN_ID_DECIMAL = MAKALU_CHAIN_ID_DECIMAL;

/** Legacy alias */
export const RPC_URL = MAKALU_RPC_URL;

export const makaluChain = defineChain({
  id: MAKALU_CHAIN_ID_DECIMAL,
  name: resolvedChainName(),
  nativeCurrency: resolvedNativeCurrency(),
  rpcUrls: { default: { http: [...MAKALU_RPC_URL_LIST] } },
  blockExplorers: { default: { name: resolvedBlockExplorerLabel(), url: EXPLORER_URL } },
});

/** Single-network deployments — key kept for compatibility. */
export type LithoNetworkKey = "makalu";

export type LithoUiNetwork = {
  key: LithoNetworkKey;
  chainId: number;
  name: string;
  rpcUrl: string;
  explorerUrl: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
};

export function lithoUiNetwork(_key: LithoNetworkKey = "makalu"): LithoUiNetwork {
  void _key;
  return {
    key: "makalu",
    chainId: MAKALU_CHAIN_ID_DECIMAL,
    name: resolvedChainName(),
    rpcUrl: MAKALU_RPC_URL,
    explorerUrl: EXPLORER_URL,
    nativeCurrency: resolvedNativeCurrency(),
  };
}

export function viemChainForChainId(chainId: number) {
  if (chainId !== MAKALU_CHAIN_ID_DECIMAL) {
    throw new Error(
      `Unsupported chain ID ${chainId}. This deployment uses ${resolvedChainName()} (${MAKALU_CHAIN_ID_DECIMAL}).`,
    );
  }
  return makaluChain;
}

export function httpTransportForChainId(chainId: number) {
  if (chainId !== MAKALU_CHAIN_ID_DECIMAL) {
    throw new Error(
      `Unsupported chain ID ${chainId}. This deployment uses ${resolvedChainName()} (${MAKALU_CHAIN_ID_DECIMAL}).`,
    );
  }
  const urls = MAKALU_RPC_URL_LIST;
  if (urls.length === 1) return http(urls[0]!);
  return fallback(urls.map((url) => http(url)));
}

/** Same URL order as HTTP fallback — use when attributing each tx to an RPC. */
export function rpcHttpUrlsForChainId(chainId: number): string[] {
  if (chainId !== MAKALU_CHAIN_ID_DECIMAL) {
    throw new Error(
      `Unsupported chain ID ${chainId}. This deployment uses ${resolvedChainName()} (${MAKALU_CHAIN_ID_DECIMAL}).`,
    );
  }
  return [...MAKALU_RPC_URL_LIST];
}

/** Hostname for UI tables (e.g. rpc-2.litho.ai). */
export function rpcEndpointLabel(url: string | undefined): string {
  if (!url?.trim()) return "—";
  try {
    return new URL(url).hostname;
  } catch {
    const s = url.replace(/^https?:\/\//i, "").split("/")[0]?.trim();
    return s || "—";
  }
}

export function isSupportedChainId(chainId: number): boolean {
  return chainId === MAKALU_CHAIN_ID_DECIMAL;
}

/** Explorer base URL for transaction links (configured chain). */
export function explorerUrlForChainId(_chainId: number): string {
  return EXPLORER_URL;
}

/** Label for jobs/UI when `chainId` matches this deployment (otherwise generic). */
export function chainDisplayLabel(chainId?: number): string {
  const id = chainId ?? MAKALU_CHAIN_ID_DECIMAL;
  if (id === MAKALU_CHAIN_ID_DECIMAL) return `${resolvedChainName()} (${id})`;
  return `Chain ${id}`;
}
