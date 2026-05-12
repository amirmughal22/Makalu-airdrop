import { formatEther, formatUnits, parseEther, parseUnits } from "viem";
import { randomBigIntInclusive } from "./random-bigint";

/** Random-range amounts use this many fractional digits in token/native human units (value + string output). */
const AMOUNT_DISPLAY_FRACTION_DIGITS = 4;

function effectiveFractionDigits(tokenDecimals: number): number {
  return Math.min(AMOUNT_DISPLAY_FRACTION_DIGITS, Math.max(0, tokenDecimals));
}

/** Smallest-unit step so human amounts align to {@link AMOUNT_DISPLAY_FRACTION_DIGITS} decimal places. */
function granularitySmallestUnits(tokenDecimals: number): bigint {
  const fd = effectiveFractionDigits(tokenDecimals);
  if (tokenDecimals <= fd) return 1n;
  return 10n ** BigInt(tokenDecimals - fd);
}

function roundToDisplayPrecision(amount: bigint, tokenDecimals: number): bigint {
  const g = granularitySmallestUnits(tokenDecimals);
  if (g === 1n) return amount;
  return (amount + g / 2n) / g * g;
}

/** Format a fixed token/native amount as a decimal string with exactly `min(4, decimals)` fractional digits (no wei tail). */
export function formatAmountAtDisplayPrecision(amount: bigint, tokenDecimals: number): string {
  const fd = effectiveFractionDigits(tokenDecimals);
  const s = formatUnits(amount, tokenDecimals);
  const neg = s.startsWith("-");
  const abs = neg ? s.slice(1) : s;
  const [whole, frac = ""] = abs.split(".");
  const fracFixed = (frac + "0".repeat(fd)).slice(0, fd);
  const sign = neg ? "-" : "";
  return `${sign}${whole}.${fracFixed}`;
}

function max(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

/**
 * Random partition of `total` into `count` integers, each in [minPer, maxPer], sum exact.
 * Returns null if impossible (caller should fall back to equal split).
 */
function randomPartitionInBounds(total: bigint, count: number, minPer: bigint, maxPer: bigint): bigint[] | null {
  const n = BigInt(count);
  if (n <= 0n) return null;
  if (minPer > maxPer) return null;
  if (total < minPer * n || total > maxPer * n) return null;

  if (n === 1n) {
    if (total < minPer || total > maxPer) return null;
    return [total];
  }

  let remaining = total;
  const out: bigint[] = [];

  for (let i = 0; i < count - 1; i++) {
    const afterThis = n - BigInt(i) - 1n;

    const lowBound = max(minPer, remaining - afterThis * maxPer);
    const highBound = min(maxPer, remaining - afterThis * minPer);

    if (lowBound > highBound) return null;

    const chunk = randomBigIntInclusive(lowBound, highBound);
    out.push(chunk);
    remaining -= chunk;
  }

  if (remaining < minPer || remaining > maxPer) return null;
  out.push(remaining);
  return out;
}

/** Split total human-readable ether string across `count` wallets (wei remainder spread). */
export function splitTotalNative(totalAmount: string, count: number): string[] {
  return splitTotalNativeSlice(totalAmount, count, 0, count);
}

/**
 * [offset, offset+length) segment of a global even split of `totalAmount` across `totalCount` wallets.
 */
export function splitTotalNativeSlice(
  totalAmount: string,
  totalCount: number,
  offset: number,
  length: number,
): string[] {
  if (length <= 0) return [];
  if (offset < 0 || totalCount < 1) return [];
  if (offset + length > totalCount) {
    throw new Error("offset+length must be <= totalCount");
  }
  const total = parseEther(totalAmount);
  const n = BigInt(totalCount);
  const base = total / n;
  const rem = total % n;
  const out: string[] = [];
  for (let i = 0; i < length; i++) {
    const g = offset + i;
    const extra = BigInt(g) < rem ? 1n : 0n;
    out.push(formatEther(base + extra));
  }
  return out;
}

/**
 * Random wei amounts summing to `totalAmount`, each between `(equal/2)` and `(equal×3)`
 * where `equal = total/count` (e.g. 250 LITHO / 100 → 1.25 … 7.5 LITHO).
 */
export function splitTotalNativeRandom(totalAmount: string, count: number): string[] {
  const total = parseEther(totalAmount);
  const n = BigInt(count);
  if (n <= 0n) return [];
  if (n === 1n) return [formatEther(total)];
  if (total < n) return splitTotalNative(totalAmount, count);

  const equalWei = total / n;
  const minWei = equalWei / 2n;
  const maxWei = equalWei * 3n;
  if (minWei === 0n) return splitTotalNative(totalAmount, count);

  const part = randomPartitionInBounds(total, count, minWei, maxWei);
  if (part) return part.map((w) => formatEther(w));

  return splitTotalNative(totalAmount, count);
}

/** Same for ERC-20 using token decimals. */
export function splitTotalToken(totalAmount: string, count: number, decimals: number): string[] {
  return splitTotalTokenSlice(totalAmount, count, 0, count, decimals);
}

/**
 * [offset, offset+length) segment of a global even split of `totalAmount` across `totalCount` token units.
 */
export function splitTotalTokenSlice(
  totalAmount: string,
  totalCount: number,
  offset: number,
  length: number,
  decimals: number,
): string[] {
  if (length <= 0) return [];
  if (offset < 0 || totalCount < 1) return [];
  if (offset + length > totalCount) {
    throw new Error("offset+length must be <= totalCount");
  }
  const total = parseUnits(totalAmount, decimals);
  const n = BigInt(totalCount);
  const base = total / n;
  const rem = total % n;
  const out: string[] = [];
  for (let i = 0; i < length; i++) {
    const g = offset + i;
    const extra = BigInt(g) < rem ? 1n : 0n;
    out.push(formatUnits(base + extra, decimals));
  }
  return out;
}

/**
 * Same bounds as {@link splitTotalNativeRandom} for ERC-20 units.
 */
export function splitTotalTokenRandom(totalAmount: string, count: number, decimals: number): string[] {
  const total = parseUnits(totalAmount, decimals);
  const n = BigInt(count);
  if (n <= 0n) return [];
  if (n === 1n) return [formatUnits(total, decimals)];
  if (total < n) return splitTotalToken(totalAmount, count, decimals);

  const equalUnits = total / n;
  const minUnits = equalUnits / 2n;
  const maxUnits = equalUnits * 3n;
  if (minUnits === 0n) return splitTotalToken(totalAmount, count, decimals);

  const part = randomPartitionInBounds(total, count, minUnits, maxUnits);
  if (part) return part.map((u) => formatUnits(u, decimals));

  return splitTotalToken(totalAmount, count, decimals);
}

/** Independent uniform random amounts in [minAmount, maxAmount] per wallet (native). Sum is not fixed. */
export function randomAmountsInRangeNative(minAmount: string, maxAmount: string, count: number): string[] {
  const tokenDecimals = 18;
  const lo = parseEther(minAmount);
  const hi = parseEther(maxAmount);
  if (lo > hi) throw new Error("Min amount must be ≤ max amount");
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const raw = randomBigIntInclusive(lo, hi);
    const rounded = roundToDisplayPrecision(raw, tokenDecimals);
    const clamped = rounded < lo ? lo : rounded > hi ? hi : rounded;
    out.push(formatAmountAtDisplayPrecision(clamped, tokenDecimals));
  }
  return out;
}

/** Same as {@link randomAmountsInRangeNative} for ERC-20 units. */
export function randomAmountsInRangeToken(
  minAmount: string,
  maxAmount: string,
  count: number,
  decimals: number,
): string[] {
  const lo = parseUnits(minAmount, decimals);
  const hi = parseUnits(maxAmount, decimals);
  if (lo > hi) throw new Error("Min amount must be ≤ max amount");
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const raw = randomBigIntInclusive(lo, hi);
    const rounded = roundToDisplayPrecision(raw, decimals);
    const clamped = rounded < lo ? lo : rounded > hi ? hi : rounded;
    out.push(formatAmountAtDisplayPrecision(clamped, decimals));
  }
  return out;
}
