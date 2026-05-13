/**
 * One-shot queue worker connectivity + claim path check (no wallet generation).
 *
 *   npm run queue:worker-self-test
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

import { assertDatabaseConfigured, bootstrapProductionEnv } from "../src/lib/queue/production-env";
import {
  collectQueueClaimBlockers,
  isAirdropQueueV2EnvEnabled,
  queueClaimBatchSize,
  queueWorkerId,
  queueWorkerPollMs,
} from "../src/lib/queue/config";
import { refreshQueueRuntimeCache } from "../src/lib/queue/queue-runtime-settings";
import { getPostgresPool, pgExecute, pgQuery } from "../src/lib/postgres";
import { claimWalletBatchDryRun, getQueueClaimDiagnostics } from "../src/lib/queue/job-queue-repo";
import { upsertWorkerHeartbeat } from "../src/lib/queue/worker-heartbeat";

bootstrapProductionEnv(ROOT);

void (async () => {
  const workerId = `${queueWorkerId()}-selftest`.slice(0, 64);
  console.info(
    JSON.stringify(
      {
        event: "queue_worker_self_test_env",
        workerId,
        AIRDROP_QUEUE_V2: process.env.AIRDROP_QUEUE_V2 ?? "(unset)",
        NODE_APP_INSTANCE: process.env.NODE_APP_INSTANCE ?? "(unset)",
        AIRDROP_WORKER_ID: process.env.AIRDROP_WORKER_ID ?? "(unset)",
        pollMs: queueWorkerPollMs(),
        claimBatchSize: queueClaimBatchSize(),
        queueClaimBlockers: collectQueueClaimBlockers(),
      },
      null,
      2,
    ),
  );

  try {
    assertDatabaseConfigured(ROOT);
  } catch (e) {
    console.error(e);
    process.exit(1);
  }

  const pool = await getPostgresPool();
  await pool.query("SELECT 1 AS ok");
  console.info(JSON.stringify({ event: "self_test_postgres_ok" }, null, 2));

  await refreshQueueRuntimeCache();
  const blockers = collectQueueClaimBlockers();
  if (blockers.length) {
    console.error(JSON.stringify({ event: "self_test_blocked", blockers }, null, 2));
    process.exit(1);
  }

  await upsertWorkerHeartbeat({
    workerId,
    iterations: 0,
    rowsOk: 0,
    rowsFail: 0,
    lastBatchSize: 0,
    activeJobId: null,
  });
  console.info(JSON.stringify({ event: "self_test_heartbeat_upserted", workerId }, null, 2));

  const simple = await pgQuery<{ c: string }>(
    pool,
    `SELECT COUNT(*)::text AS c FROM job_wallets
     WHERE status = 'pending'
       AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())`,
  );
  const claimableSimple = Number(simple[0]?.c ?? 0);

  const diag = await getQueueClaimDiagnostics();
  const dryIds = await claimWalletBatchDryRun(workerId);

  const analysis =
    dryIds.length > 0
      ? "Dry-run claimed rows (txn rolled back) — real claim path works for at least one batch."
      : claimableSimple > 0 && diag.matchingClaimSql === 0
        ? "Simple pending count > 0 but matchingClaimSql=0 — pending rows are on draft/paused jobs, lack effective signer, or retry cap."
        : claimableSimple > 0 && diag.matchingClaimSql > 0
          ? "matchingClaimSql>0 but dry-run returned 0 — signer NOT EXISTS / DISTINCT contention or all rows skipped by SKIP_LOCKED in this snapshot; check concurrent workers and claim SQL."
          : "No claimable pending rows in DB for this definition.";

  console.info(
    JSON.stringify(
      {
        event: "self_test_claim_summary",
        claimablePendingSimple: claimableSimple,
        matchingClaimSql: diag.matchingClaimSql,
        pendingBlockedByJobState: diag.pendingBlockedByJobState,
        pendingButDraftJob: diag.pendingButDraftJob,
        dryRunClaimedIdsCount: dryIds.length,
        dryRunFirstIds: dryIds.slice(0, 12),
        analysis,
      },
      null,
      2,
    ),
  );

  if (!isAirdropQueueV2EnvEnabled()) {
    console.error(JSON.stringify({ event: "self_test_warn", detail: "AIRDROP_QUEUE_V2 not true in env" }, null, 2));
  }

  await pgExecute(pool, `DELETE FROM queue_worker_heartbeats WHERE worker_id = ?`, [workerId]);
  console.info(JSON.stringify({ event: "self_test_heartbeat_cleaned", workerId }, null, 2));

  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
