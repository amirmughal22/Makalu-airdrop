/**
 * Migrate legacy `airdrop_jobs.resultsJson` into normalized `jobs` + `job_wallets`.
 *
 *   npm run migrate-old-jobs
 *   MIGRATE_LEGACY_DRY_RUN=1 npm run migrate-old-jobs
 *   MIGRATE_LEGACY_JOB_ID=<uuid> npm run migrate-old-jobs
 *   MIGRATE_LEGACY_LIMIT=50 npm run migrate-old-jobs
 *
 * Requires DATABASE_URL (or DB_* vars). Set AIRDROP_QUEUE_V2=true and run `npm run worker:queue` to continue sends.
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { ensureDatabaseUrl } = require("../database-url.js") as { ensureDatabaseUrl: () => void };
ensureDatabaseUrl();

function truthyEnv(name: string): boolean {
  const v = process.env[name]?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

void (async () => {
  if (!process.env.DATABASE_URL?.trim()) {
    console.error("[migrate-old-jobs] DATABASE_URL is required.");
    process.exit(1);
  }

  const { migrateLegacyJobsToQueue, migrateLegacyChunkSizeFromEnv } = await import(
    "../src/lib/migrations/migrate-legacy-jobs-to-queue"
  );

  const dryRun = truthyEnv("MIGRATE_LEGACY_DRY_RUN");
  const limitRaw = process.env.MIGRATE_LEGACY_LIMIT?.trim();
  const limit = limitRaw ? Math.max(1, parseInt(limitRaw, 10) || 10000) : 10000;
  const jobId = process.env.MIGRATE_LEGACY_JOB_ID?.trim() || null;
  const chunkEnv = process.env.MIGRATE_LEGACY_CHUNK?.trim();
  const chunkSize = chunkEnv ? Math.max(50, parseInt(chunkEnv, 10) || migrateLegacyChunkSizeFromEnv()) : migrateLegacyChunkSizeFromEnv();

  console.log(
    `[migrate-old-jobs] dryRun=${dryRun} limit=${limit}${jobId ? ` jobId=${jobId}` : ""} chunk=${chunkSize}`,
  );

  const report = await migrateLegacyJobsToQueue({ dryRun, limit, jobId, chunkSize });

  if (report.failures.length > 0) {
    console.error("[migrate-old-jobs] failures:", report.failures);
    process.exit(1);
  }
  process.exit(0);
})();
