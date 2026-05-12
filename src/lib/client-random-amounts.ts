import { formatUnits, parseEther, parseUnits } from "viem";

/** Uniform random bigint in [minInclusive, maxInclusive] using Web Crypto (browser-safe). */
function randomBigIntInclusiveWeb(minInclusive: bigint, maxInclusive: bigint): bigint {
  if (maxInclusive < minInclusive) throw new Error("invalid range");
  const c = typeof globalThis !== "undefined" ? globalThis.crypto : undefined;
  if (!c?.getRandomValues) throw new Error("Web Crypto is not available");
  const range = maxInclusive - minInclusive + 1n;
  const bitLen = range.toString(2).length;
  const mask = (1n << BigInt(bitLen)) - 1n;
  for (;;) {
    const nbytes = Math.ceil(bitLen / 8);
    const buf = new Uint8Array(nbytes);
    c.getRandomValues(buf);
    let x = 0n;
    for (let i = 0; i < buf.length; i++) x = (x << 8n) | BigInt(buf[i]!);
    x &= mask;
    if (x < range) return minInclusive + x;
  }
}

const AMOUNT_DISPLAY_FRACTION_DIGITS = 4;

function effectiveFractionDigits(tokenDecimals: number): number {
  return Math.min(AMOUNT_DISPLAY_FRACTION_DIGITS, Math.max(0, tokenDecimals));
}

function granularitySmallestUnits(tokenDecimals: number): bigint {
  const fd = effectiveFractionDigits(tokenDecimals);
  if (tokenDecimals <= fd) return 1n;
  return 10n ** BigInt(tokenDecimals - fd);
}

function roundToDisplayPrecision(amount: bigint, tokenDecimals: number): bigint {
  const g = granularitySmallestUnits(tokenDecimals);
  if (g === 1n) return amount;
  return ((amount + g / 2n) / g) * g;
}

function formatAmountAtDisplayPrecision(amount: bigint, tokenDecimals: number): string {
  const fd = effectiveFractionDigits(tokenDecimals);
  const s = formatUnits(amount, tokenDecimals);
  const neg = s.startsWith("-");
  const abs = neg ? s.slice(1) : s;
  const [whole, frac = ""] = abs.split(".");
  const fracFixed = (frac + "0".repeat(fd)).slice(0, fd);
  const sign = neg ? "-" : "";
  return `${sign}${whole}.${fracFixed}`;
}

/** Random native amounts in [min, max] for use in client-only flows (no Node `crypto`). */
export function clientRandomAmountsInRangeNative(minAmount: string, maxAmount: string, count: number): string[] {
  const tokenDecimals = 18;
  const lo = parseEther(minAmount);
  const hi = parseEther(maxAmount);
  if (lo > hi) throw new Error("Min amount must be ≤ max amount");
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const raw = randomBigIntInclusiveWeb(lo, hi);
    const rounded = roundToDisplayPrecision(raw, tokenDecimals);
    const clamped = rounded < lo ? lo : rounded > hi ? hi : rounded;
    out.push(formatAmountAtDisplayPrecision(clamped, tokenDecimals));
  }
  return out;
}

/** Random token amounts in [min, max] for use in client-only flows. */
export function clientRandomAmountsInRangeToken(
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
    const raw = randomBigIntInclusiveWeb(lo, hi);
    const rounded = roundToDisplayPrecision(raw, decimals);
    const clamped = rounded < lo ? lo : rounded > hi ? hi : rounded;
    out.push(formatAmountAtDisplayPrecision(clamped, decimals));
  }
  return out;
}
