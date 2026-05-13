import { getPostgresPool, pgQuery } from "../postgres";
import { getQueueClaimDiagnostics } from "./job-queue-repo";
import { refreshQueueRuntimeCache, getQueueRuntimeCacheMeta } from "./queue-runtime-settings";
import { CLAIM_JOB_ELIGIBLE_WHERE } from "./claim-select-sql";

/** Jobs with pending/processing work whose row has not moved in this many seconds — stall heuristic. */
const STALE_JOB_SEC = 600;

export type QueueOperationalSnapshot = {
  diagnostics: Awaited<ReturnType<typeof getQueueClaimDiagnostics>>;
  runtimeMeta: ReturnType<typeof getQueueRuntimeCacheMeta>;
  stalledQueuedJobsSample: Array<{
    id: string;
    status: string;
    paused: number;
    pendingWallets: number;
    ageMsSinceJobUpdate: number;
  }>;
  staleHeartbeatWorkers: number;
  draftJobsWithPendingWallets: number;
};

export async function getQueueOperationalSnapshot(): Promise<QueueOperationalSnapshot> {
  await refreshQueueRuntimeCache();
  const diagnostics = await getQueueClaimDiagnostics();
  const runtimeMeta = getQueueRuntimeCacheMeta();
  const pool = await getPostgresPool();

  const stalledRows = await pgQuery<Record<string, unknown>>(
    pool,
    `SELECT j.id, j.status, j.paused,
            EXTRACT(EPOCH FROM (NOW() - j.updated_at)) * 1000 AS age_ms,
            (SELECT COUNT(*) FROM job_wallets jw WHERE jw.job_id = j.id AND jw.status = 'pending') AS pend
     FROM jobs j
     WHERE (${CLAIM_JOB_ELIGIBLE_WHERE})
       AND EXISTS (SELECT 1 FROM job_wallets jw2 WHERE jw2.job_id = j.id AND jw2.status IN ('pending','processing'))
       AND j.updated_at < NOW() - (? * INTERVAL '1 second')
     ORDER BY j.updated_at ASC
     LIMIT 15`,
    [STALE_JOB_SEC],
  );

  const stalledQueuedJobsSample = stalledRows.map((r) => ({
    id: String(r.id),
    status: String(r.status),
    paused: Boolean(r.paused) ? 1 : 0,
    pendingWallets: Number(r.pend ?? 0),
    ageMsSinceJobUpdate: Math.max(0, Number(r.age_ms ?? 0)),
  }));

  const hbStale = await pgQuery<{ c: string }>(
    pool,
    `SELECT COUNT(*)::text AS c FROM queue_worker_heartbeats
     WHERE last_heartbeat < NOW() - INTERVAL '5 minutes'`,
  );
  const staleHeartbeatWorkers = Number(hbStale[0]?.c ?? 0);

  const draftPend = await pgQuery<{ c: string }>(
    pool,
    `SELECT COUNT(DISTINCT j.id)::text AS c FROM jobs j
     INNER JOIN job_wallets jw ON jw.job_id = j.id
     WHERE j.status = 'draft' AND jw.status = 'pending'`,
  );
  const draftJobsWithPendingWallets = Number(draftPend[0]?.c ?? 0);

  return {
    diagnostics,
    runtimeMeta,
    stalledQueuedJobsSample,
    staleHeartbeatWorkers,
    draftJobsWithPendingWallets,
  };
}
