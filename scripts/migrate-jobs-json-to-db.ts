/**
 * One-time: copy jobs from `data/airdrop-jobs.json` into MySQL `airdrop_jobs`.
 * Requires DATABASE_URL (or split DB_* vars) in .env.
 *
 *   npm run jobs:migrate-to-db
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import type { StoredJob } from "../src/lib/job-types";

const require = createRequire(import.meta.url);
const { ensureDatabaseUrl } = require("../database-url.js") as { ensureDatabaseUrl: () => void };

const DATA_FILE = path.join(process.cwd(), "data", "airdrop-jobs.json");

function toJob(item: unknown): StoredJob | null {
  if (!item || typeof item !== "object") return null;
  const j = item as Partial<StoredJob> & { jobId?: string };
  if (!j.jobId || !j.owner) return null;
  return {
    jobId: j.jobId,
    owner: j.owner,
    signerAddress: j.signerAddress,
    signerAddresses: j.signerAddresses,
    status: (j.status as StoredJob["status"]) || "draft",
    mode: (j.mode as StoredJob["mode"]) || "native",
    tokenAddress: j.tokenAddress,
    chainId: j.chainId,
    scheduledAt: j.scheduledAt,
    queuedAt: j.queuedAt,
    createdAt: j.createdAt || new Date().toISOString(),
    results: Array.isArray(j.results) ? j.results : [],
    paused: Boolean(j.paused),
    targetRunCount: j.targetRunCount,
    currentRun: j.currentRun,
  };
}

async function main() {
  ensureDatabaseUrl();
  if (!process.env.DATABASE_URL?.trim()) {
    console.error(
      "DATABASE_URL is not set. Add it to .env, or set DB_HOST, DB_USER, DB_PASSWORD, and DB_DATABASE (or DB_NAME).",
    );
    process.exit(1);
  }
  if (!fs.existsSync(DATA_FILE)) {
    console.log("No data/airdrop-jobs.json found — nothing to migrate.");
    process.exit(0);
  }
  const raw = JSON.parse(fs.readFileSync(DATA_FILE, "utf8")) as unknown;
  if (!Array.isArray(raw) || raw.length === 0) {
    console.log("Job file is empty — nothing to migrate.");
    process.exit(0);
  }
  const { saveJobToDb } = await import("../src/lib/job-db");
  let n = 0;
  for (const item of raw) {
    const job = toJob(item);
    if (!job) continue;
    await saveJobToDb(job);
    n += 1;
  }
  console.log(
    `Migrated ${n} job(s) to MySQL (airdrop_jobs). Verify the data, then set AIRDROP_JOBS_DATABASE_ONLY=true. You may archive or remove data/airdrop-jobs.json when done.`,
  );
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
