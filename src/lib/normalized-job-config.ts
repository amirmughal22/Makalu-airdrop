import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { ensureDatabaseUrl } = require("../../database-url.js") as { ensureDatabaseUrl: () => void };

/**
 * When true (default if DATABASE_URL is set), APIs read/write `jobs` + `job_wallets` only — not `airdrop_jobs.resultsJson`.
 * Set AIRDROP_NORMALIZED_JOBS=false to fall back to legacy JSON rows (not recommended once migrated).
 */
export function useNormalizedJobStorage(): boolean {
  try {
    ensureDatabaseUrl();
  } catch {
    return false;
  }
  if (!process.env.DATABASE_URL?.trim()) return false;
  const v = process.env.AIRDROP_NORMALIZED_JOBS?.trim().toLowerCase();
  if (v === "0" || v === "false" || v === "no") return false;
  return true;
}
