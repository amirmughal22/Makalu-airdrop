/**
 * Cron-friendly watchdog: if claimable wallet rows exist but no fresh worker heartbeat,
 * restart the PM2 queue worker process.
 *
 *   npm run worker:watchdog
 *
 * Requires: pm2 on PATH, same .env as app, METRICS_SECRET optional (not used here — DB checks only).
 */
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

import { assertDatabaseConfigured, bootstrapProductionEnv } from "../src/lib/queue/production-env";

const PM2_NAME = process.env.PM2_WORKER_NAME?.trim() || "makalu-queue-worker";

void (async () => {
  bootstrapProductionEnv(ROOT);
  assertDatabaseConfigured(ROOT);

  const { getQueueOperationalSnapshot } = await import("../src/lib/queue/queue-operations-snapshot");
  const snap = await getQueueOperationalSnapshot();
  const match = snap.diagnostics.matchingClaimSql;

  if (match <= 0) {
    console.info("[worker-watchdog] No claimable rows — nothing to do.");
    process.exit(0);
  }

  const { getPostgresPool, pgQuery } = await import("../src/lib/postgres");
  const pool = await getPostgresPool();
  const freshRows = await pgQuery<{ c: string }>(
    pool,
    `SELECT COUNT(*)::text AS c FROM queue_worker_heartbeats
     WHERE last_heartbeat >= NOW() - INTERVAL '8 minutes'`,
  );
  const freshCount = Number(freshRows[0]?.c ?? 0);

  if (freshCount > 0) {
    console.info("[worker-watchdog] Claimable rows:", match, "recent heartbeat(s):", freshCount, "— OK.");
    process.exit(0);
  }

  console.warn(
    "[worker-watchdog] Stall suspected — claimable rows:",
    match,
    "recent heartbeats (8m window):",
    freshCount,
    "staleHeartbeatWorkers:",
    snap.staleHeartbeatWorkers,
    "— restarting",
    PM2_NAME,
  );

  try {
    execSync(`pm2 restart ${PM2_NAME}`, { stdio: "inherit", env: process.env });
  } catch {
    console.error("[worker-watchdog] pm2 restart failed — install PM2 and ensure process name matches:", PM2_NAME);
    process.exit(1);
  }
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
