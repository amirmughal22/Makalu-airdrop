/** Prevents two overlapping executeJob loops for the same job id (process-local). */
const running = new Set<string>();

export function tryAcquireJobRun(jobId: string): boolean {
  if (running.has(jobId)) return false;
  running.add(jobId);
  return true;
}

export function releaseJobRun(jobId: string): void {
  running.delete(jobId);
}

export function isJobRunActive(jobId: string): boolean {
  return running.has(jobId);
}

/** How many distinct airdrop jobs are currently in executeJob (process-local). */
export function activeJobRunCount(): number {
  return running.size;
}
