/**
 * Normalized PostgreSQL queue worker — production entry for PM2 / Coolify.
 * Loads `.env` without requiring `node --env-file` (see {@link bootstrapProductionEnv}).
 *
 * Production bundle: `npm run build:worker` → `node dist/worker/airdrop-queue-worker.cjs`
 *
 * Logs: logs/worker.log, logs/startup-debug.log (when diagnostics enabled)
 */
import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Directory containing this worker entry. Must work for:
 * - `node dist/worker/airdrop-queue-worker.cjs` (esbuild strips `import.meta.url` in CJS — do not rely on it alone)
 * - `tsx scripts/airdrop-queue-worker.ts` (argv contains the `.ts` path)
 */
function resolveWorkerEntryDirname(): string {
  for (let i = process.argv.length - 1; i >= 1; i--) {
    const a = process.argv[i];
    if (!a) continue;
    const base = path.basename(a);
    if (base === "airdrop-queue-worker.ts" || base === "airdrop-queue-worker.cjs" || base === "airdrop-queue-worker.js") {
      return path.dirname(path.resolve(a));
    }
  }
  console.warn(
    "[airdrop-queue-worker] Could not resolve script path from argv — using process.cwd() for project root detection. Prefer invoking as `node dist/worker/airdrop-queue-worker.cjs` or `tsx scripts/airdrop-queue-worker.ts`.",
  );
  return process.cwd();
}

const __dirnameSrc = resolveWorkerEntryDirname();

/** `scripts/` or bundled `dist/worker/` → project root */
function resolveProjectRoot(): string {
  const d = __dirnameSrc;
  const norm = d.replace(/\\/g, "/");
  if (norm.endsWith("/dist/worker") || norm.includes("/dist/worker")) {
    return path.resolve(d, "../..");
  }
  if (path.basename(d) === "scripts") {
    return path.resolve(d, "..");
  }
  if (existsSync(path.join(d, "package.json"))) {
    return path.resolve(d);
  }
  return path.resolve(d, "..");
}

const PROJECT_ROOT = resolveProjectRoot();

import { assertDatabaseConfigured, bootstrapProductionEnv } from "../src/lib/queue/production-env";
import { appendStartupDebugLine, printAndLogStartupDiagnostics } from "../src/lib/queue/runtime-queue-diag";
import { WorkerFileLogger } from "../src/lib/queue/worker-file-logger";
import { deleteWorkerHeartbeat } from "../src/lib/queue/worker-heartbeat";

process.on("uncaughtException", (err) => {
  console.error("[airdrop-queue-worker] FATAL uncaughtException:", err);
  appendStartupDebugLine(PROJECT_ROOT, `uncaughtException: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  console.error("[airdrop-queue-worker] FATAL unhandledRejection:", reason);
  appendStartupDebugLine(PROJECT_ROOT, `unhandledRejection: ${String(reason)}`);
  process.exit(1);
});

void (async () => {
  let loadedEnvFiles: string[] = [];
  try {
    const boot = bootstrapProductionEnv(PROJECT_ROOT);
    loadedEnvFiles = boot.loadedEnvFiles;
    assertDatabaseConfigured(PROJECT_ROOT);
  } catch (e) {
    console.error("[airdrop-queue-worker] Env bootstrap failed:", e instanceof Error ? e.message : e);
    process.exit(1);
  }

  if (!process.env.AIRDROP_QUEUE_V2?.trim().match(/^(1|true|yes)$/i)) {
    console.error("[airdrop-queue-worker] AIRDROP_QUEUE_V2 must be true to run this worker.");
    process.exit(1);
  }

  printAndLogStartupDiagnostics(PROJECT_ROOT, __dirnameSrc, loadedEnvFiles);

  const {
    collectQueueClaimBlockers,
    embeddedNormalizedQueueWorkerEnabled,
    queueClaimBatchSize,
    queueWorkerPollMs,
    queueWorkerId,
  } = await import("../src/lib/queue/config");
  const { refreshQueueRuntimeCache, getQueueRuntimeFlagsSync } = await import("../src/lib/queue/queue-runtime-settings");
  await refreshQueueRuntimeCache();

  const flagsLine = `after_refresh processing=${getQueueRuntimeFlagsSync().processingEnabled} normalized_queue_v2=${getQueueRuntimeFlagsSync().normalizedQueueV2} embedded_worker_flag=${getQueueRuntimeFlagsSync().embeddedWorker}`;
  console.info("[startup-diag]", flagsLine);
  appendStartupDebugLine(PROJECT_ROOT, flagsLine);

  const claimBlockers = collectQueueClaimBlockers();
  if (claimBlockers.length > 0) {
    console.error("[airdrop-queue-worker] Queue claims blocked — exiting (fix dashboard / DB / env):");
    for (const line of claimBlockers) console.error(`  - ${line}`);
    process.exit(1);
  }

  if (embeddedNormalizedQueueWorkerEnabled()) {
    console.warn(
      "[airdrop-queue-worker] Embedded worker effective in DB/env — duplicate risk if Next also embeds. Prefer AIRDROP_EMBEDDED_QUEUE_WORKER=false for PM2-only.",
    );
  }

  const { getPostgresPool } = await import("../src/lib/postgres");
  const pool = await getPostgresPool();
  console.log("[airdrop-queue-worker] PostgreSQL pool ready");

  const strict = process.env.AIRDROP_QUEUE_STRICT_STARTUP?.trim() === "true";
  const { validateNormalizedQueueIndexes, validateQueueRuntimeRowPresent } = await import(
    "../src/lib/queue/queue-startup-validation",
  );
  const ix = await validateNormalizedQueueIndexes(pool);
  if (!ix.ok) {
    console.error("[airdrop-queue-worker] index validation:", ix.errors.join("; "));
    if (strict) process.exit(1);
  }
  const row = await validateQueueRuntimeRowPresent(pool);
  for (const w of row.warnings) console.warn("[airdrop-queue-worker]", w);

  const { initWorkerLivenessClock } = await import("../src/lib/queue/queue-worker-liveness");
  initWorkerLivenessClock();

  const { runAirdropQueueWorker } = await import("../src/lib/queue/queue-worker");
  const abort = new AbortController();
  const workerId = queueWorkerId();
  const fileLogger = new WorkerFileLogger(PROJECT_ROOT);
  fileLogger.log("info", "startup_config", {
    workerId,
    pollMs: queueWorkerPollMs(),
    claimBatchSize: queueClaimBatchSize(),
    strictStartup: strict,
    projectRoot: PROJECT_ROOT,
    argv0: process.argv[0],
  });

  const shutdown = (sig: string) => {
    console.info(`[airdrop-queue-worker] ${sig} received — draining batch then stopping`);
    abort.abort();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  console.log(
    `[airdrop-queue-worker] started workerId=${workerId} poll ~${queueWorkerPollMs()}ms batch ≤${queueClaimBatchSize()} · set AIRDROP_QUEUE_RUNTIME_DIAG=1 for per-claim SQL logs`,
  );

  await runAirdropQueueWorker(abort.signal, {
    workerId,
    fileLogger,
    onStopped: async () => {
      await deleteWorkerHeartbeat(workerId);
      console.info("[airdrop-queue-worker] heartbeat cleared");
    },
  });
  console.log("[airdrop-queue-worker] exit");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
