/** Max distributor / funder addresses per normalized airdrop job (round-robin assignment). */
export const MAX_DISTRIBUTOR_SIGNERS_PER_JOB = 100;

export function assertSignerCountWithinJobLimit(addressesLower: string[], label = "distributor wallets"): void {
  if (addressesLower.length > MAX_DISTRIBUTOR_SIGNERS_PER_JOB) {
    throw new Error(`At most ${MAX_DISTRIBUTOR_SIGNERS_PER_JOB} ${label} per job (got ${addressesLower.length}).`);
  }
}
