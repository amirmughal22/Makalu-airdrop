import * as fs from "node:fs";
import * as path from "node:path";
import { HDNodeWallet, Mnemonic } from "ethers";
import { privateKeyToAccount } from "viem/accounts";
import { getPrivateKeyForDistributor } from "./distributor";

type StoredManagedWallet = {
  owner: string;
  address: string;
  label: string;
  privateKey: `0x${string}`;
  createdAt: string;
  /** Set when this row was derived from `AIRDROP_HD_MNEMONIC` (BIP-44 child). */
  hdDerivationIndex?: number;
};

export type DistributorWalletMeta = {
  address: string;
  label: string;
  createdAt: string;
  source: "primary" | "added" | "hd-generated";
};

/** Full backup row (includes private keys) — same session-gated download as HD batch export. */
export type DistributorWalletExportRow = {
  address: string;
  label: string;
  createdAt: string;
  source: DistributorWalletMeta["source"];
  privateKey: string;
  hdDerivationIndex?: number;
  derivationPath?: string;
};

/** One row returned to the client after HD generation so keys can be downloaded (same batch only). */
export type HdWalletBatchExportRow = {
  address: string;
  label: string;
  hdDerivationIndex: number;
  derivationPath: string;
  privateKey: string;
};

const DATA_FILE = path.join(process.cwd(), "data", "distributor-wallets.json");
const g = globalThis as unknown as { __distributorWallets?: Map<string, StoredManagedWallet> };
/** Last `data/distributor-wallets.json` mtime we fully loaded into memory (see {@link hydrateIfNeeded}). */
let lastLoadedDiskMtimeMs: number | null = null;

function store(): Map<string, StoredManagedWallet> {
  if (!g.__distributorWallets) g.__distributorWallets = new Map();
  hydrateIfNeeded(g.__distributorWallets);
  return g.__distributorWallets;
}

function storageKey(ownerLower: string, walletLower: string): string {
  return `${ownerLower}:${walletLower}`;
}

/**
 * Reload from disk when the JSON file changes. A single `hydrated` flag breaks with multiple Next.js workers
 * or another process touching the same file — one worker could keep an empty/stale map forever.
 */
function hydrateIfNeeded(map: Map<string, StoredManagedWallet>) {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      return;
    }
    const mtime = fs.statSync(DATA_FILE).mtimeMs;
    if (lastLoadedDiskMtimeMs !== null && mtime === lastLoadedDiskMtimeMs) {
      return;
    }

    const raw = fs.readFileSync(DATA_FILE, "utf8");
    const arr = JSON.parse(raw) as StoredManagedWallet[];
    if (!Array.isArray(arr)) return;

    map.clear();
    for (const item of arr) {
      if (!item?.owner || !item?.address || !item?.privateKey) continue;
      const owner = item.owner.toLowerCase();
      const address = item.address.toLowerCase();
      const hdRaw = (item as StoredManagedWallet).hdDerivationIndex;
      const hdDerivationIndex =
        typeof hdRaw === "number" && Number.isFinite(hdRaw) && hdRaw >= 0 ? Math.floor(hdRaw) : undefined;
      map.set(storageKey(owner, address), {
        owner,
        address,
        label: typeof (item as StoredManagedWallet).label === "string" ? (item as StoredManagedWallet).label : "",
        privateKey: item.privateKey,
        createdAt: item.createdAt || new Date().toISOString(),
        ...(hdDerivationIndex !== undefined ? { hdDerivationIndex } : {}),
      });
    }
    lastLoadedDiskMtimeMs = mtime;
  } catch (e) {
    console.error("[distributor-wallets] hydrate failed", e);
  }
}

function persist(map: Map<string, StoredManagedWallet>) {
  try {
    const dir = path.dirname(DATA_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify([...map.values()]), "utf8");
    try {
      lastLoadedDiskMtimeMs = fs.statSync(DATA_FILE).mtimeMs;
    } catch {
      /* ignore */
    }
  } catch (e) {
    console.error("[distributor-wallets] persist failed", e);
  }
}

function normalizePk(input: string): `0x${string}` {
  const value = input.trim();
  if (!value) throw new Error("Private key is required.");
  const prefixed = value.startsWith("0x") ? value : `0x${value}`;
  try {
    privateKeyToAccount(prefixed as `0x${string}`);
  } catch {
    throw new Error("Invalid private key.");
  }
  return prefixed as `0x${string}`;
}

export function listDistributorWallets(ownerAddress: string): DistributorWalletMeta[] {
  const ownerLower = ownerAddress.toLowerCase();
  const list: DistributorWalletMeta[] = [];

  if (getPrivateKeyForDistributor(ownerLower)) {
    list.push({
      address: ownerLower,
      label: "Authorized wallet",
      createdAt: new Date(0).toISOString(),
      source: "primary",
    });
  }

  for (const item of store().values()) {
    if (item.owner !== ownerLower) continue;
    list.push({
      address: item.address,
      label: item.label || "",
      createdAt: item.createdAt,
      source: typeof item.hdDerivationIndex === "number" ? "hd-generated" : "added",
    });
  }

  list.sort((a, b) => {
    if (a.source === "primary" && b.source !== "primary") return -1;
    if (b.source === "primary" && a.source !== "primary") return 1;
    return a.createdAt.localeCompare(b.createdAt);
  });
  return list;
}

function maxHdDerivationIndexForOwner(ownerLower: string): number {
  let max = -1;
  for (const item of store().values()) {
    if (item.owner !== ownerLower) continue;
    if (typeof item.hdDerivationIndex === "number" && Number.isFinite(item.hdDerivationIndex)) {
      max = Math.max(max, item.hdDerivationIndex);
    }
  }
  return max;
}

/**
 * Derives the next `count` BIP-44 Ethereum accounts from `AIRDROP_HD_MNEMONIC`, stores private keys like manually added wallets, and returns their public metadata.
 * Path: `{AIRDROP_HD_BASE_PATH || "m/44'/60'/0'/0"}/{index}` with monotonically increasing index per owner.
 */
export function generateChildWalletsFromEnvMnemonic(
  ownerAddress: string,
  count: number,
): { wallets: DistributorWalletMeta[]; hdExport: HdWalletBatchExportRow[] } {
  const mnemonic = process.env.AIRDROP_HD_MNEMONIC?.trim();
  if (!mnemonic) {
    throw new Error("Server env AIRDROP_HD_MNEMONIC is not set. Add a BIP-39 phrase to generate HD child wallets.");
  }
  const ownerLower = ownerAddress.toLowerCase();
  const n = Math.floor(Number(count));
  if (!Number.isFinite(n) || n < 1 || n > 100) {
    throw new Error("count must be between 1 and 100.");
  }

  const basePath = (process.env.AIRDROP_HD_BASE_PATH?.trim() || "m/44'/60'/0'/0").replace(/\/+$/, "");
  /** Master root at depth 0 — `fromPhrase` alone defaults to `m/44'/60'/0'/0/0` and cannot take another `m/...` path. */
  let root: HDNodeWallet;
  try {
    const mn = Mnemonic.fromPhrase(mnemonic);
    root = HDNodeWallet.fromSeed(mn.computeSeed());
  } catch {
    throw new Error("AIRDROP_HD_MNEMONIC is not a valid BIP-39 phrase.");
  }

  const start = maxHdDerivationIndexForOwner(ownerLower) + 1;
  const out: DistributorWalletMeta[] = [];
  const hdExport: HdWalletBatchExportRow[] = [];

  let index = start;
  let attempts = 0;
  const maxAttempts = n + 10_000;

  for (let generated = 0; generated < n; ) {
    if (attempts++ > maxAttempts) {
      throw new Error(
        "Could not find enough free HD indices (too many derived addresses already in your wallet list). Remove duplicates or change AIRDROP_HD_BASE_PATH.",
      );
    }
    const fullPath = `${basePath}/${index}`;
    let pkHex: `0x${string}`;
    try {
      const child = root.derivePath(fullPath);
      pkHex = child.privateKey as `0x${string}`;
    } catch (e) {
      throw new Error(e instanceof Error ? e.message : "HD derivation failed.");
    }
    const privateKey = normalizePk(pkHex);
    const address = privateKeyToAccount(privateKey).address.toLowerCase();
    const key = storageKey(ownerLower, address);
    if (address === ownerLower || store().has(key)) {
      index += 1;
      continue;
    }
    const label = `HD #${index}`;
    const row: StoredManagedWallet = {
      owner: ownerLower,
      address,
      label,
      privateKey,
      createdAt: new Date().toISOString(),
      hdDerivationIndex: index,
    };
    store().set(key, row);
    out.push({ address, label, createdAt: row.createdAt, source: "hd-generated" });
    hdExport.push({
      address,
      label,
      hdDerivationIndex: index,
      derivationPath: fullPath,
      privateKey,
    });
    generated += 1;
    index += 1;
  }
  persist(store());
  return { wallets: out, hdExport };
}

export type RegisterEnvSeedRangeResult = {
  wallets: DistributorWalletMeta[];
  hdExport: HdWalletBatchExportRow[];
  skipped: number;
};

/**
 * Registers consecutive derivation indices using server `AIRDROP_HD_MNEMONIC` / `AIRDROP_HD_BASE_PATH`
 * (same paths as “Generate and register”). Skips addresses already in your list or equal to the primary wallet.
 * Use to bulk re-import after losing `data/distributor-wallets.json` without pasting the phrase in the browser.
 */
export function registerEnvSeedIndexRange(
  ownerAddress: string,
  startIndex: number,
  count: number,
): RegisterEnvSeedRangeResult {
  const mnemonic = process.env.AIRDROP_HD_MNEMONIC?.trim();
  if (!mnemonic) {
    throw new Error("Server env AIRDROP_HD_MNEMONIC is not set.");
  }

  const ownerLower = ownerAddress.toLowerCase();
  const start = Math.floor(Number(startIndex));
  const n = Math.floor(Number(count));
  if (!Number.isFinite(start) || start < 0) {
    throw new Error("startIndex must be a non-negative integer.");
  }
  if (!Number.isFinite(n) || n < 1 || n > 500) {
    throw new Error("count must be between 1 and 500.");
  }
  if (start > 1_000_000) {
    throw new Error("startIndex is too large.");
  }

  const basePath = (process.env.AIRDROP_HD_BASE_PATH?.trim() || "m/44'/60'/0'/0").replace(/\/+$/, "");

  let root: HDNodeWallet;
  try {
    const mn = Mnemonic.fromPhrase(mnemonic);
    root = HDNodeWallet.fromSeed(mn.computeSeed());
  } catch {
    throw new Error("AIRDROP_HD_MNEMONIC is not a valid BIP-39 phrase.");
  }

  const out: DistributorWalletMeta[] = [];
  const hdExport: HdWalletBatchExportRow[] = [];
  let skipped = 0;

  for (let index = start; index < start + n; index++) {
    const fullPath = `${basePath}/${index}`;
    let pkHex: `0x${string}`;
    try {
      const child = root.derivePath(fullPath);
      pkHex = child.privateKey as `0x${string}`;
    } catch (e) {
      throw new Error(e instanceof Error ? e.message : "HD derivation failed.");
    }
    const privateKey = normalizePk(pkHex);
    const address = privateKeyToAccount(privateKey).address.toLowerCase();
    const key = storageKey(ownerLower, address);
    if (address === ownerLower || store().has(key)) {
      skipped += 1;
      continue;
    }
    const label = `HD #${index}`;
    const row: StoredManagedWallet = {
      owner: ownerLower,
      address,
      label,
      privateKey,
      createdAt: new Date().toISOString(),
      hdDerivationIndex: index,
    };
    store().set(key, row);
    out.push({ address, label, createdAt: row.createdAt, source: "hd-generated" });
    hdExport.push({
      address,
      label,
      hdDerivationIndex: index,
      derivationPath: fullPath,
      privateKey,
    });
  }
  persist(store());
  return { wallets: out, hdExport, skipped };
}

/** True if `walletAddress` is any distributor row for this owner (primary or stored). */
export function isKnownDistributorAddress(ownerAddress: string, walletAddress: string): boolean {
  return Boolean(getOwnerWalletPrivateKey(ownerAddress, walletAddress));
}

export function addDistributorWallet(ownerAddress: string, privateKeyInput: string, labelInput: string): DistributorWalletMeta {
  const ownerLower = ownerAddress.toLowerCase();
  const privateKey = normalizePk(privateKeyInput);
  const label = String(labelInput || "").trim().slice(0, 60);
  if (!label) throw new Error("Wallet label is required.");
  const address = privateKeyToAccount(privateKey).address.toLowerCase();
  if (address === ownerLower) {
    throw new Error("Primary authorized wallet is already available.");
  }
  const key = storageKey(ownerLower, address);
  if (store().has(key)) {
    throw new Error("Wallet already added.");
  }
  const next: StoredManagedWallet = {
    owner: ownerLower,
    address,
    label,
    privateKey,
    createdAt: new Date().toISOString(),
  };
  store().set(key, next);
  persist(store());
  return { address: next.address, label: next.label, createdAt: next.createdAt, source: "added" };
}

export function removeDistributorWallet(ownerAddress: string, walletAddress: string): void {
  const ownerLower = ownerAddress.toLowerCase();
  const walletLower = walletAddress.toLowerCase();
  if (walletLower === ownerLower) {
    throw new Error("Authorized wallet cannot be removed.");
  }
  const key = storageKey(ownerLower, walletLower);
  if (!store().has(key)) {
    throw new Error("Wallet not found.");
  }
  store().delete(key);
  persist(store());
}

export function getOwnerWalletPrivateKey(ownerAddress: string, walletAddress: string): `0x${string}` | null {
  const ownerLower = ownerAddress.toLowerCase();
  const walletLower = walletAddress.toLowerCase();
  if (walletLower === ownerLower) return getPrivateKeyForDistributor(ownerLower);
  return store().get(storageKey(ownerLower, walletLower))?.privateKey ?? null;
}

export function ownerHasWallet(ownerAddress: string, walletAddress: string): boolean {
  return Boolean(getOwnerWalletPrivateKey(ownerAddress, walletAddress));
}

export function isHdMnemonicConfigured(): boolean {
  return Boolean(process.env.AIRDROP_HD_MNEMONIC?.trim());
}

/**
 * All distributor wallets for this owner with private keys, in the same order as {@link listDistributorWallets}.
 * Used for JSON backup; keep file offline — same sensitivity as HD generate download.
 */
export function exportDistributorWalletsWithKeys(ownerAddress: string): DistributorWalletExportRow[] {
  const ownerLower = ownerAddress.toLowerCase();
  const metas = listDistributorWallets(ownerAddress);
  const basePath = (process.env.AIRDROP_HD_BASE_PATH?.trim() || "m/44'/60'/0'/0").replace(/\/+$/, "");
  const out: DistributorWalletExportRow[] = [];

  for (const meta of metas) {
    const pk = getOwnerWalletPrivateKey(ownerAddress, meta.address);
    if (!pk) continue;
    const row: DistributorWalletExportRow = {
      address: meta.address,
      label: meta.label,
      createdAt: meta.createdAt,
      source: meta.source,
      privateKey: pk,
    };
    if (meta.source === "hd-generated") {
      const key = storageKey(ownerLower, meta.address.toLowerCase());
      const stored = store().get(key);
      const idx = stored?.hdDerivationIndex;
      if (typeof idx === "number" && Number.isFinite(idx) && idx >= 0) {
        row.hdDerivationIndex = idx;
        row.derivationPath = `${basePath}/${idx}`;
      }
    }
    out.push(row);
  }
  return out;
}
