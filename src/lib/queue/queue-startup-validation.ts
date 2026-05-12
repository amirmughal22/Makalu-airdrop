import type { Pool } from "pg";
import { pgQuery } from "../postgres";

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
    const schemaRows = await pgQuery<{ n: string }>(pool, `SELECT current_schema() AS n`);
    const schema = String(schemaRows[0]?.n ?? "").trim();
    if (!schema) {
      errors.push("Could not resolve current_schema() for index validation.");
      return { ok: false, errors, warnings };
    }

    for (const { table, name } of REQUIRED_INDEXES) {
      const idx = await pgQuery<{ c: string }>(
        pool,
        `SELECT COUNT(*)::text AS c FROM pg_indexes WHERE schemaname = ? AND tablename = ? AND indexname = ?`,
        [schema, table, name],
      );
      const c = Number(idx[0]?.c ?? 0);
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
    const rows = await pgQuery<{ id: number }>(pool, `SELECT id FROM queue_runtime_settings WHERE id = 1`);
    if (!rows.length) {
      warnings.push("queue_runtime_settings row id=1 missing — defaults apply until INSERT.");
    }
  } catch (e) {
    errors.push(`queue_runtime_settings check failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  return { ok: errors.length === 0, errors, warnings };
}
