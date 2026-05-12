/**
 * Manual claim path test: runs one claim transaction and rolls back (rows unchanged).
 *   npm run queue:test
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

import { assertDatabaseConfigured, bootstrapProductionEnv } from "../src/lib/queue/production-env";
import { refreshQueueRuntimeCache } from "../src/lib/queue/queue-runtime-settings";
import { collectQueueClaimBlockers, queueWorkerId } from "../src/lib/queue/config";
import { claimWalletBatchDryRun } from "../src/lib/queue/job-queue-repo";

bootstrapProductionEnv(ROOT);
assertDatabaseConfigured(ROOT);

void (async () => {
  await refreshQueueRuntimeCache();
  const blockers = collectQueueClaimBlockers();
  console.info("[queue:test] blockers:", blockers.length ? blockers : "(none)");
  if (blockers.length > 0) {
    console.error("[queue:test] FAIL cannot claim while blocked");
    process.exit(1);
  }
  const wid = `${queueWorkerId()}-dry`;
  const ids = await claimWalletBatchDryRun(wid);
  console.info("[queue:test] dry-run claimed wallet row ids (rolled back):", ids);
  console.info(ids.length ? "[queue:test] PASS" : "[queue:test] PASS (no rows to claim right now)");
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
