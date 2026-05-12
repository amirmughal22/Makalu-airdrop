import type { RowDataPacket } from "mysql2";
import { getMysqlPool } from "../mysql";
import { getQueueClaimDiagnostics } from "./job-queue-repo";
import { refreshQueueRuntimeCache, getQueueRuntimeCacheMeta } from "./queue-runtime-settings";

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
  const pool = await getMysqlPool();

  const [stalledRows] = await pool.execute<RowDataPacket[]>(
    `SELECT j.id, j.status, j.paused,
            TIMESTAMPDIFF(SECOND, j.updated_at, CURRENT_TIMESTAMP(3)) * 1000 AS age_ms,
            (SELECT COUNT(*) FROM job_wallets jw WHERE jw.job_id = j.id AND jw.status = 'pending') AS pend
     FROM jobs j
     WHERE j.status IN ('queued','running')
       AND j.paused = 0
       AND EXISTS (SELECT 1 FROM job_wallets jw2 WHERE jw2.job_id = j.id AND jw2.status IN ('pending','processing'))
       AND j.updated_at < DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL ${STALE_JOB_SEC} SECOND)
     ORDER BY j.updated_at ASC
     LIMIT 15`,
  );

  const stalledQueuedJobsSample = stalledRows.map((r) => ({
    id: String(r.id),
    status: String(r.status),
    paused: Number(r.paused ?? 0),
    pendingWallets: Number(r.pend ?? 0),
    ageMsSinceJobUpdate: Math.max(0, Number(r.age_ms ?? 0)),
  }));

  const [hbStale] = await pool.execute<RowDataPacket[]>(
    `SELECT COUNT(*) AS c FROM queue_worker_heartbeats
     WHERE last_heartbeat < DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL 5 MINUTE)`,
  );
  const staleHeartbeatWorkers = Number((hbStale[0] as { c: number }).c ?? 0);

  const [draftPend] = await pool.execute<RowDataPacket[]>(
    `SELECT COUNT(DISTINCT j.id) AS c FROM jobs j
     INNER JOIN job_wallets jw ON jw.job_id = j.id
     WHERE j.status = 'draft' AND jw.status = 'pending'`,
  );
  const draftJobsWithPendingWallets = Number((draftPend[0] as { c: number }).c ?? 0);

  return {
    diagnostics,
    runtimeMeta,
    stalledQueuedJobsSample,
    staleHeartbeatWorkers,
    draftJobsWithPendingWallets,
  };
}
