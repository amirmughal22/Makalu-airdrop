/**
 * Emergency single-batch processor — claims one batch, sends txs, exits.
 *   npm run queue:process-once
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

import { assertDatabaseConfigured, bootstrapProductionEnv } from "../src/lib/queue/production-env";
import { refreshQueueRuntimeCache } from "../src/lib/queue/queue-runtime-settings";
import { collectQueueClaimBlockers } from "../src/lib/queue/config";
import { claimWalletBatch, reconcileJobStatusesFromWallets } from "../src/lib/queue/job-queue-repo";
import { processClaimedWalletRow } from "../src/lib/queue/queue-worker";
import { queueWorkerId } from "../src/lib/queue/config";

bootstrapProductionEnv(ROOT);
assertDatabaseConfigured(ROOT);

void (async () => {
  await refreshQueueRuntimeCache();
  const blockers = collectQueueClaimBlockers();
  if (blockers.length > 0) {
    console.error("[queue:process-once] blocked:", blockers.join("; "));
    process.exit(1);
  }
  const wid = queueWorkerId();
  const batch = await claimWalletBatch(wid);
  if (!batch.length) {
    console.info("[queue:process-once] no rows claimed — exit");
    process.exit(0);
  }
  console.info("[queue:process-once] processing", batch.length, "row(s)");
  for (const row of batch) {
    await processClaimedWalletRow(row);
  }
  await reconcileJobStatusesFromWallets([...new Set(batch.map((row) => row.jobId))]);
  console.info("[queue:process-once] done");
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
