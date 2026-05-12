import { privateKeyToAccount } from "viem/accounts";

function parseKeySegments(): string[] {
  const raw = process.env.AIRDROP_PRIVATE_KEY?.trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function isValidPk(segment: string): segment is `0x${string}` {
  if (!segment.startsWith("0x") || segment.length < 66) return false;
  try {
    privateKeyToAccount(segment as `0x${string}`);
    return true;
  } catch {
    return false;
  }
}

/** All configured distributor private keys (comma-separated in AIRDROP_PRIVATE_KEY). */
export function getDistributorPrivateKeys(): `0x${string}`[] {
  const out: `0x${string}`[] = [];
  for (const seg of parseKeySegments()) {
    if (isValidPk(seg)) out.push(seg);
  }
  return out;
}

/** Addresses derived from all configured keys (order matches getDistributorPrivateKeys). */
export function getDistributorAddresses(): `0x${string}`[] {
  return getDistributorPrivateKeys().map((pk) => privateKeyToAccount(pk).address);
}

/** Key whose address matches `address` (for running a job owned by that wallet). */
export function getPrivateKeyForDistributor(address: string): `0x${string}` | null {
  const want = address.toLowerCase();
  for (const pk of getDistributorPrivateKeys()) {
    if (privateKeyToAccount(pk).address.toLowerCase() === want) return pk;
  }
  return null;
}

/** @deprecated Prefer getDistributorPrivateKeys / getPrivateKeyForDistributor — returns first key if any. */
export function getDistributorPrivateKey(): `0x${string}` | null {
  const keys = getDistributorPrivateKeys();
  return keys[0] ?? null;
}

/** First distributor address, if any (multi-key: only one of several). */
export function getDistributorAddress(): `0x${string}` | null {
  const addrs = getDistributorAddresses();
  return addrs[0] ?? null;
}
