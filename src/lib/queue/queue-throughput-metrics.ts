import { getPostgresPool, pgQuery } from "../postgres";
import { CLAIM_JOB_ELIGIBLE_WHERE } from "./claim-select-sql";

export type QueueThroughputMetrics = {
  activeSigners: number;
  txPerMinute1: number;
  txPerMinute5: number;
  failedTxPerMinute1: number;
};

/**
 * `activeSigners` = distinct signer addresses with pending or processing wallet rows on active jobs.
 * Tx/min counts use `job_wallets.updated_at` when status is completed/failed (approximation of finish rate).
 */
export async function getQueueThroughputMetrics(): Promise<QueueThroughputMetrics> {
  const pool = await getPostgresPool();
  const rows = await pgQuery<{
    active_signers: string;
    tx_1m: string;
    tx_5m: string;
    fail_1m: string;
  }>(
    pool,
    `WITH active AS (
       SELECT COUNT(DISTINCT lower(trim(jw.signer_address)))::text AS c
       FROM job_wallets jw
       INNER JOIN jobs j ON j.id = jw.job_id
       WHERE jw.status IN ('pending', 'processing')
         AND (${CLAIM_JOB_ELIGIBLE_WHERE})
         AND jw.signer_address IS NOT NULL
         AND length(trim(jw.signer_address)) > 0
     ),
     t1 AS (
       SELECT COUNT(*)::text AS c FROM job_wallets
       WHERE status = 'completed' AND updated_at > NOW() - INTERVAL '1 minute'
     ),
     t5 AS (
       SELECT COUNT(*)::text AS c FROM job_wallets
       WHERE status = 'completed' AND updated_at > NOW() - INTERVAL '5 minutes'
     ),
     f1 AS (
       SELECT COUNT(*)::text AS c FROM job_wallets
       WHERE status = 'failed' AND updated_at > NOW() - INTERVAL '1 minute'
     )
     SELECT (SELECT c FROM active) AS active_signers,
            (SELECT c FROM t1) AS tx_1m,
            (SELECT c FROM t5) AS tx_5m,
            (SELECT c FROM f1) AS fail_1m`,
    [],
  );
  const r = rows[0];
  const num = (s: string | undefined) => Math.max(0, Math.floor(Number(s ?? "0") || 0));
  return {
    activeSigners: num(r?.active_signers),
    txPerMinute1: num(r?.tx_1m),
    txPerMinute5: Math.round(num(r?.tx_5m) / 5),
    failedTxPerMinute1: num(r?.fail_1m),
  };
}
