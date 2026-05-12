import type { RowDataPacket } from "mysql2";
import { getMysqlPool } from "../mysql";
import { collectEmbeddedWorkerBlockers, collectQueueClaimBlockers, isAirdropQueueV2EnvEnabled } from "./config";
import { getQueueOperationalSnapshot } from "./queue-operations-snapshot";
import { getQueueRuntimeFlagsSync, refreshQueueRuntimeCache } from "./queue-runtime-settings";

export type QueueDiagnosticsPayload = {
  pid: number;
  /** Non-secret hints */
  env: {
    nodeEnv: string | undefined;
    databaseUrlPresent: boolean;
    airDropQueueV2Env: boolean;
    globalPausedEnv: string | undefined;
    metricsSecretConfigured: boolean;
  };
  queueClaimBlockers: string[];
  embeddedWorkerBlockers: string[];
  runtimeFlags: ReturnType<typeof getQueueRuntimeFlagsSync>;
  operational: Awaited<ReturnType<typeof getQueueOperationalSnapshot>>;
  workerHeartbeats: Array<{
    worker_id: string;
    hostname: string | null;
    last_heartbeat: string | null;
    iterations: number | null;
    rows_ok: number | null;
    rows_fail: number | null;
    last_batch_size: number | null;
    active_job_id: string | null;
  }>;
};

export async function buildQueueDiagnosticsPayload(): Promise<QueueDiagnosticsPayload> {
  await refreshQueueRuntimeCache();
  const pool = await getMysqlPool();
  const [hbRows] = await pool.execute<RowDataPacket[]>(
    `SELECT worker_id, hostname, last_heartbeat, iterations, rows_ok, rows_fail, last_batch_size, active_job_id
     FROM queue_worker_heartbeats
     ORDER BY last_heartbeat DESC
     LIMIT 30`,
  );

  const operational = await getQueueOperationalSnapshot();

  return {
    pid: process.pid,
    env: {
      nodeEnv: process.env.NODE_ENV,
      databaseUrlPresent: Boolean(process.env.DATABASE_URL?.trim()),
      airDropQueueV2Env: isAirdropQueueV2EnvEnabled(),
      globalPausedEnv: process.env.AIRDROP_QUEUE_GLOBAL_PAUSED,
      metricsSecretConfigured: Boolean(process.env.METRICS_SECRET?.trim()),
    },
    queueClaimBlockers: collectQueueClaimBlockers(),
    embeddedWorkerBlockers: collectEmbeddedWorkerBlockers(),
    runtimeFlags: getQueueRuntimeFlagsSync(),
    operational,
    workerHeartbeats: hbRows.map((r) => ({
      worker_id: String(r.worker_id ?? ""),
      hostname: r.hostname != null ? String(r.hostname) : null,
      last_heartbeat: r.last_heartbeat != null ? String(r.last_heartbeat) : null,
      iterations: r.iterations != null ? Number(r.iterations) : null,
      rows_ok: r.rows_ok != null ? Number(r.rows_ok) : null,
      rows_fail: r.rows_fail != null ? Number(r.rows_fail) : null,
      last_batch_size: r.last_batch_size != null ? Number(r.last_batch_size) : null,
      active_job_id: r.active_job_id != null ? String(r.active_job_id) : null,
    })),
  };
}
