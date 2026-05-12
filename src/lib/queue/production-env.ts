/**
 * Load `.env` from project root for worker scripts and CLI tools without relying on `node --env-file`
 * (older Node / Plesk may not support it).
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { loadEnvConfig } from "@next/env";

export type ProductionEnvBootstrapResult = {
  projectRoot: string;
  /** Masked — safe to log */
  databaseUrlConfigured: boolean;
  /** Human-readable summary for ops logs */
  loadSummary: string;
  /** Paths checked (non-sensitive) */
  loadedEnvFiles: string[];
};

function tryDotenvFallback(projectRoot: string): { keys: number; path: string | null } {
  const envPath = path.join(projectRoot, ".env");
  if (!existsSync(envPath)) return { keys: 0, path: null };
  try {
    // Optional dependency — npm installes `dotenv` for Plesk compatibility.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const dotenv = require("dotenv") as { config: (o: { path: string; override?: boolean }) => { parsed?: Record<string, string> } };
    const r = dotenv.config({ path: envPath, override: false });
    const n = r.parsed ? Object.keys(r.parsed).length : 0;
    return { keys: n, path: envPath };
  } catch {
    return { keys: 0, path: envPath };
  }
}

/**
 * Next.js-style discovery of `.env`, `.env.local`, `.env.production`, … then optional dotenv read of `.env`.
 */
export function bootstrapProductionEnv(projectRoot: string): ProductionEnvBootstrapResult {
  const resolved = path.resolve(projectRoot);
  const loadEnvResult = loadEnvConfig(resolved);
  const loadedEnvFiles = loadEnvResult.loadedEnvFiles?.map((f) => f.path) ?? [];

  let loadSummary = `@next/env loaded ${loadedEnvFiles.length} file(s)`;
  const dot = tryDotenvFallback(resolved);
  if (dot.keys > 0) {
    loadSummary += `; dotenv fallback merged ${dot.keys} key(s) from ${path.basename(dot.path!)}`;
  }

  const { ensureDatabaseUrl } = require(path.join(resolved, "database-url.js")) as {
    ensureDatabaseUrl: () => void;
  };
  ensureDatabaseUrl();

  const dbUrl = Boolean(process.env.DATABASE_URL?.trim());
  return {
    projectRoot: resolved,
    databaseUrlConfigured: dbUrl,
    loadSummary,
    loadedEnvFiles: loadedEnvFiles.map(String),
  };
}

/** Call after {@link bootstrapProductionEnv}. Fails loudly if DB env cannot resolve to DATABASE_URL. */
export function assertDatabaseConfigured(projectRoot: string): void {
  const hasUrl = Boolean(process.env.DATABASE_URL?.trim());
  const hasParts =
    Boolean(process.env.DB_HOST?.trim()) &&
    Boolean(process.env.DB_USER?.trim()) &&
    Boolean((process.env.DB_DATABASE || process.env.DB_NAME)?.trim());
  if (!hasUrl && !hasParts) {
    throw new Error(
      `Missing database configuration (${projectRoot}): set DATABASE_URL or DB_HOST + DB_USER + DB_DATABASE (and DB_PASSWORD / DB_PORT). Ensure .env exists in project root.`,
    );
  }
  if (!process.env.DATABASE_URL?.trim()) {
    throw new Error(
      "DATABASE_URL is still empty after ensureDatabaseUrl() — fix DB_* variables or DATABASE_URL in .env.",
    );
  }
}
