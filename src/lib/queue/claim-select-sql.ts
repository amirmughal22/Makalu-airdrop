/**
 * Shared SQL fragments for wallet batch claim so diagnostics EXPLAIN stays aligned.
 * Resolves signer when `job_wallets.signer_address` is null (legacy / migration) from `jobs`.
 */

export function claimEffectiveSignerExpr(walletAlias: string, jobAlias: string): string {
  return `COALESCE(
    NULLIF(TRIM(${walletAlias}.signer_address), ''),
    NULLIF(TRIM(${jobAlias}.signer_address), ''),
    NULLIF(TRIM(${jobAlias}.signer_addresses_json #>> '{0}'), '')
  )`;
}

export const CLAIM_ES_JW_J = claimEffectiveSignerExpr("jw", "j");
export const CLAIM_ES_JW2_J2 = claimEffectiveSignerExpr("jw2", "j2");
export const CLAIM_ES_PX_JP = claimEffectiveSignerExpr("px", "jp");

/** UPDATE … FROM jobs j — same coalesce as claim SELECT (backfill column for partial unique index). */
export const CLAIM_BACKFILL_SIGNER_FROM_JOB = `COALESCE(
  NULLIF(TRIM(jw.signer_address), ''),
  NULLIF(TRIM(j.signer_address), ''),
  NULLIF(TRIM(j.signer_addresses_json #>> '{0}'), '')
)`;

/** Parent `jobs` row predicate for claim SQL (`paused` null-safe). */
export function claimJobEligibleWhere(jobAlias: string): string {
  return `(${jobAlias}.paused IS NOT TRUE AND ${jobAlias}.status IN ('queued', 'running', 'processing'))`;
}

export const CLAIM_JOB_ELIGIBLE_WHERE = claimJobEligibleWhere("j");

/**
 * Tie-breaker after `DISTINCT ON (signer)` so one job cannot monopolize every wallet for the same signer
 * purely by `jobs.queued_at` (interleaves jobs deterministically).
 */
export function claimWalletBatchOrderBy(walletAlias: string, jobAlias: string): string {
  return `md5(${walletAlias}.job_id::text || ':' || ${walletAlias}.id::text), ${jobAlias}.queued_at ASC NULLS LAST, ${jobAlias}.id, ${walletAlias}.id`;
}

export const CLAIM_WALLET_ORDER_BY_JW_J = claimWalletBatchOrderBy("jw", "j");
export const CLAIM_WALLET_ORDER_BY_JW2_J2 = claimWalletBatchOrderBy("jw2", "j2");
