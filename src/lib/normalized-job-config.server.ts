import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/**
 * Server-only: reads DATABASE_URL / AIRDROP_NORMALIZED_JOBS after `ensureDatabaseUrl()`.
 * Do not import from client components — use a boolean prop from a Server Component instead.
 */
export function getNormalizedJobStorageServer(): boolean {
  try {
    const { ensureDatabaseUrl } = require("../../database-url.js") as { ensureDatabaseUrl: () => void };
    ensureDatabaseUrl();
  } catch {
    return false;
  }
  if (!process.env.DATABASE_URL?.trim()) return false;
  const v = process.env.AIRDROP_NORMALIZED_JOBS?.trim().toLowerCase();
  if (v === "0" || v === "false" || v === "no") return false;
  return true;
}
