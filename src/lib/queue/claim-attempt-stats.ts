/** In-process ring buffer for recent claim attempts (Next.js + standalone worker runs separately). */

export type ClaimAttemptRecord = {
  at: string;
  workerId: string;
  claimMs: number;
  rowsReturned: number;
  pendingWalletApprox?: number;
  queuedJobsApprox?: number;
  blockers?: string[];
};

const MAX = 50;
const ring: ClaimAttemptRecord[] = [];

export function recordClaimAttempt(rec: ClaimAttemptRecord): void {
  ring.push(rec);
  while (ring.length > MAX) ring.shift();
}

export function getRecentClaimAttempts(): ClaimAttemptRecord[] {
  return [...ring];
}
