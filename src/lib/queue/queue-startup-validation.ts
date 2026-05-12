import type { Pool } from "mysql2/promise";
import type { RowDataPacket } from "mysql2";

export type QueueStartupValidationResult = {
  ok: boolean;
  errors: string[];
  warnings: string[];
};

const REQUIRED_INDEXES: Array<{ table: string; name: string }> = [
  { table: "job_wallets", name: "idx_job_wallets_pending_claim" },
  { table: "jobs", name: "idx_jobs_status_queue" },
];

/**
 * Fail loudly when critical indexes are missing (claim performance / correctness).
 */
export async function validateNormalizedQueueIndexes(pool: Pool): Promise<QueueStartupValidationResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  try {
    const [dbRows] = await pool.execute<RowDataPacket[]>(`SELECT DATABASE() AS db`);
    const schema = String((dbRows[0] as { db?: string })?.db ?? "").trim();
    if (!schema) {
      errors.push("Could not resolve current DATABASE() for index validation.");
      return { ok: false, errors, warnings };
    }

    for (const { table, name } of REQUIRED_INDEXES) {
      const [idx] = await pool.execute<RowDataPacket[]>(
        `SELECT COUNT(*) AS c FROM INFORMATION_SCHEMA.STATISTICS
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = ?`,
        [schema, table, name],
      );
      const c = Number((idx[0] as { c: number }).c ?? 0);
      if (c < 1) {
        errors.push(`Missing index ${name} on ${table} — run app schema bootstrap / migrations.`);
      }
    }
  } catch (e) {
    errors.push(`Index validation failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  return { ok: errors.length === 0, errors, warnings };
}

export async function validateQueueRuntimeRowPresent(pool: Pool): Promise<QueueStartupValidationResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  try {
    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT id FROM queue_runtime_settings WHERE id = 1`,
    );
    if (!rows.length) {
      warnings.push("queue_runtime_settings row id=1 missing — defaults apply until INSERT.");
    }
  } catch (e) {
    errors.push(`queue_runtime_settings check failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  return { ok: errors.length === 0, errors, warnings };
}
