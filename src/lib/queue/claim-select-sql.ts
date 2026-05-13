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
