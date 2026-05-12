/** Ordered slice of distributor wallets from `fromAddr` through `toAddr` (inclusive), by list order. */

export function rangeEndpointsFromAddresses(
  wallets: readonly { address: string }[],
  addresses: readonly string[],
): { from: string; to: string } | null {
  if (!wallets.length || !addresses.length) return null;
  const allowed = new Set(addresses.map((a) => a.trim().toLowerCase()).filter(Boolean));
  let minI = Infinity;
  let maxI = -1;
  wallets.forEach((w, i) => {
    if (allowed.has(w.address.toLowerCase())) {
      minI = Math.min(minI, i);
      maxI = Math.max(maxI, i);
    }
  });
  if (maxI < 0 || !Number.isFinite(minI)) return null;
  return { from: wallets[minI]!.address, to: wallets[maxI]!.address };
}

/** Same addresses in order (case-insensitive); avoids useless state updates. */
export function executionAddressListsEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i]!.toLowerCase() !== b[i]!.toLowerCase()) return false;
  }
  return true;
}

export function addressesInExecutionRange(
  wallets: readonly { address: string }[],
  fromAddr: string,
  toAddr: string,
): string[] {
  if (!wallets.length) return [];
  const a = fromAddr.trim().toLowerCase();
  const b = toAddr.trim().toLowerCase();
  let iFrom = wallets.findIndex((w) => w.address.toLowerCase() === a);
  let iTo = wallets.findIndex((w) => w.address.toLowerCase() === b);
  if (iFrom < 0) iFrom = 0;
  if (iTo < 0) iTo = wallets.length - 1;
  if (iFrom > iTo) [iFrom, iTo] = [iTo, iFrom];
  return wallets.slice(iFrom, iTo + 1).map((w) => w.address);
}
