import { randomBytes } from "node:crypto";

/** Uniform random bigint in [0, maxExclusive). */
export function randomBigIntBelow(maxExclusive: bigint): bigint {
  if (maxExclusive <= 0n) throw new Error("maxExclusive must be positive");
  const bitLen = maxExclusive.toString(2).length;
  const mask = (1n << BigInt(bitLen)) - 1n;
  for (;;) {
    const nbytes = Math.ceil(bitLen / 8);
    const buf = randomBytes(nbytes);
    let x = 0n;
    for (let i = 0; i < buf.length; i++) x = (x << 8n) | BigInt(buf[i]);
    x &= mask;
    if (x < maxExclusive) return x;
  }
}

/** Uniform random bigint in [minInclusive, maxInclusive]. */
export function randomBigIntInclusive(minInclusive: bigint, maxInclusive: bigint): bigint {
  if (maxInclusive < minInclusive) throw new Error("invalid range");
  const range = maxInclusive - minInclusive + 1n;
  return minInclusive + randomBigIntBelow(range);
}
