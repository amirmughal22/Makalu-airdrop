import { getNormalizedJobStorageServer } from "./normalized-job-config.server";

/**
 * When true (default if DATABASE_URL is set), APIs read/write `jobs` + `job_wallets` only — not `airdrop_jobs.resultsJson`.
 * Set `AIRDROP_NORMALIZED_JOBS=false` to fall back to legacy JSON rows (not recommended once migrated).
 */
export function useNormalizedJobStorage(): boolean {
  return getNormalizedJobStorageServer();
}

export { getNormalizedJobStorageServer } from "./normalized-job-config.server";
