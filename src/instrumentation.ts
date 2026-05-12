import { ensureDatabaseUrl } from "@/lib/database-url-env";

export async function register() {
  if (process.env.NEXT_RUNTIME === "edge") return;
  ensureDatabaseUrl();

  /** When `false`, run `npm run worker` separately so the site stays fast while many jobs run in parallel. */
  if (process.env.AIRDROP_EMBEDDED_WORKER !== "false") {
    const { ensureJobQueueWorker } = await import("@/lib/job-queue");
    ensureJobQueueWorker();
  }

  const { refreshQueueRuntimeCache } = await import("@/lib/queue/queue-runtime-settings");
  await refreshQueueRuntimeCache();

  try {
    const { getPostgresPool } = await import("@/lib/postgres");
    const pool = await getPostgresPool();
    const { validateNormalizedQueueIndexes, validateQueueRuntimeRowPresent } = await import(
      "@/lib/queue/queue-startup-validation",
    );
    const ix = await validateNormalizedQueueIndexes(pool);
    if (!ix.ok) {
      console.error("[instrumentation] normalized queue index validation failed:", ix.errors.join("; "));
    }
    const row = await validateQueueRuntimeRowPresent(pool);
    for (const w of row.warnings) console.warn("[instrumentation] queue runtime:", w);
  } catch (e) {
    console.warn("[instrumentation] queue startup validation skipped:", e instanceof Error ? e.message : e);
  }

  const { collectEmbeddedWorkerBlockers } = await import("@/lib/queue/config");
  const { startEmbeddedQueueWorkerIfEligible, embeddedQueueWorkerActiveLoopCount } = await import(
    "@/lib/queue/embedded-queue-lifecycle",
  );
  const blockers = collectEmbeddedWorkerBlockers();
  if (blockers.length > 0) {
    console.warn("[instrumentation] Embedded normalized queue worker OFF:", blockers.join(" · "));
  }
  startEmbeddedQueueWorkerIfEligible();
  const loops = embeddedQueueWorkerActiveLoopCount();
  if (blockers.length === 0) {
    console.info(`[instrumentation] Embedded normalized queue worker ON (${loops} loop(s))`);
  }
}
