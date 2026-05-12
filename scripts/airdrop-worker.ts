/**
 * Dedicated airdrop queue process: run alongside the Next.js server with the same .env.
 * Set AIRDROP_EMBEDDED_WORKER=false on the web app so only this process executes jobs.
 *
 * Example:
 *   AIRDROP_EMBEDDED_WORKER=false AIRDROP_MAX_CONCURRENT_JOBS=12 npm run worker
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { ensureDatabaseUrl } = require("../database-url.js") as { ensureDatabaseUrl: () => void };
ensureDatabaseUrl();

void (async () => {
  const [{ ensureJobQueueWorker, queuePollIntervalMs }, { maxConcurrentAirdropJobs }] = await Promise.all([
    import("../src/lib/job-queue"),
    import("../src/lib/rpc-retry"),
  ]);
  ensureJobQueueWorker();
  console.log(
    `[airdrop-worker] running (poll ${queuePollIntervalMs()}ms, max ${maxConcurrentAirdropJobs()} concurrent jobs; stop with Ctrl+C)`,
  );
})();
