import { hostname } from "node:os";
import { getPostgresPool, pgExecute } from "../postgres";

/** Remove heartbeat row on graceful shutdown so ops does not show a stale “live” worker. */
export async function deleteWorkerHeartbeat(workerId: string): Promise<void> {
  try {
    const pool = await getPostgresPool();
    await pgExecute(pool, `DELETE FROM queue_worker_heartbeats WHERE worker_id = ?`, [workerId.slice(0, 64)]);
  } catch {
    /* ignore */
  }
}

/** Persist worker liveness for ops / Grafana / stale detection. */
export async function upsertWorkerHeartbeat(opts: {
  workerId: string;
  iterations: number;
  rowsOk: number;
  rowsFail: number;
  lastBatchSize: number;
  /** Primary job id from last batch (single-job batches only), for ops visibility. */
  activeJobId?: string | null;
}): Promise<void> {
  const pool = await getPostgresPool();
  const aj = opts.activeJobId?.trim().slice(0, 64) || null;
  await pgExecute(
    pool,
    `INSERT INTO queue_worker_heartbeats (
       worker_id, hostname, active_job_id, last_heartbeat, iterations, rows_ok, rows_fail, last_batch_size
     ) VALUES (?, ?, ?, NOW(), ?, ?, ?, ?)
     ON CONFLICT (worker_id) DO UPDATE SET
       hostname = EXCLUDED.hostname,
       active_job_id = EXCLUDED.active_job_id,
       last_heartbeat = NOW(),
       iterations = EXCLUDED.iterations,
       rows_ok = EXCLUDED.rows_ok,
       rows_fail = EXCLUDED.rows_fail,
       last_batch_size = EXCLUDED.last_batch_size,
       updated_at = NOW()`,
    [
      opts.workerId.slice(0, 64),
      hostname().slice(0, 255),
      aj,
      opts.iterations,
      opts.rowsOk,
      opts.rowsFail,
      opts.lastBatchSize,
    ],
  );
}
