/**
 * Build mix transfer rows.
 * - Default: wallet i sends to wallet (i+1) mod n.
 * - With `shuffleRecipients`: every loop uses a random non-self recipient mapping.
 * Signer order must match `job.signerAddresses` wave order (index k → signer k % n).
 */
export function buildMixRotationRecipients(
  orderedSignerAddresses: string[],
  loops: number,
  amounts: string[],
  options?: { shuffleRecipients?: boolean },
): Array<{ id: string; address: string; amount: string }> {
  const n = orderedSignerAddresses.length;
  if (n < 2) return [];
  const total = n * loops;
  if (amounts.length !== total) {
    throw new Error(`Expected ${total} amounts, got ${amounts.length}`);
  }
  const signers = orderedSignerAddresses.map((a) => a.toLowerCase());
  const out: Array<{ id: string; address: string; amount: string }> = [];
  let ai = 0;
  const shuffleRecipients = Boolean(options?.shuffleRecipients);
  for (let c = 0; c < loops; c++) {
    const recipientsForLoop = shuffleRecipients ? shuffledDerangement(signers) : nextRingRecipients(signers);
    for (let i = 0; i < n; i++) {
      const to = recipientsForLoop[i]!;
      out.push({
        id: String(out.length + 1),
        address: to,
        amount: amounts[ai]!,
      });
      ai++;
    }
  }
  return out;
}

function nextRingRecipients(signers: string[]): string[] {
  return signers.map((_, i) => signers[(i + 1) % signers.length]!);
}

/** Returns a shuffled recipient array where recipients[i] !== signers[i] for every i. */
function shuffledDerangement(signers: string[]): string[] {
  const n = signers.length;
  const idx = Array.from({ length: n }, (_, i) => i);
  for (let tries = 0; tries < 200; tries++) {
    fisherYatesInPlace(idx);
    let ok = true;
    for (let i = 0; i < n; i++) {
      if (idx[i] === i) {
        ok = false;
        break;
      }
    }
    if (ok) return idx.map((j) => signers[j]!);
  }
  return nextRingRecipients(signers);
}

function fisherYatesInPlace(arr: number[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randomIntInclusive(0, i);
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
}

function randomIntInclusive(min: number, max: number): number {
  const range = max - min + 1;
  const c = typeof globalThis !== "undefined" ? globalThis.crypto : undefined;
  if (!c?.getRandomValues) return min + Math.floor(Math.random() * range);
  const maxUint = 0x1_0000_0000;
  const maxUnbiased = maxUint - (maxUint % range);
  const buf = new Uint32Array(1);
  for (;;) {
    c.getRandomValues(buf);
    const x = buf[0]!;
    if (x < maxUnbiased) return min + (x % range);
  }
}

/** Stable order: order of appearance in the catalog list. */
export function orderedSelectedWallets(
  catalogOrdered: { address: string }[],
  selectedLower: Set<string>,
): string[] {
  return catalogOrdered.filter((w) => selectedLower.has(w.address.toLowerCase())).map((w) => w.address);
}
