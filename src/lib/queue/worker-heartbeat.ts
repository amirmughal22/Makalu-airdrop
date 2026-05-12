import { hostname } from "node:os";
import { getMysqlPool } from "../mysql";

/** Remove heartbeat row on graceful shutdown so ops does not show a stale “live” worker. */
export async function deleteWorkerHeartbeat(workerId: string): Promise<void> {
  try {
    const pool = await getMysqlPool();
    await pool.execute(`DELETE FROM queue_worker_heartbeats WHERE worker_id = ? LIMIT 1`, [
      workerId.slice(0, 64),
    ]);
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
  const pool = await getMysqlPool();
  const aj = opts.activeJobId?.trim().slice(0, 64) || null;
  await pool.execute(
    `INSERT INTO queue_worker_heartbeats (
       worker_id, hostname, active_job_id, last_heartbeat, iterations, rows_ok, rows_fail, last_batch_size
     ) VALUES (?, ?, ?, CURRENT_TIMESTAMP(3), ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       hostname = VALUES(hostname),
       active_job_id = VALUES(active_job_id),
       last_heartbeat = CURRENT_TIMESTAMP(3),
       iterations = VALUES(iterations),
       rows_ok = VALUES(rows_ok),
       rows_fail = VALUES(rows_fail),
       last_batch_size = VALUES(last_batch_size),
       updated_at = CURRENT_TIMESTAMP(3)`,
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
