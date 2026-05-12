-- Marks legacy `airdrop_jobs` rows that have been copied into normalized `jobs` + `job_wallets`.
-- Safe to run once; app bootstrap uses ER_DUP_* ignores for idempotent apply.

ALTER TABLE airdrop_jobs
  ADD COLUMN migrated_to_queue TINYINT(1) NOT NULL DEFAULT 0;

CREATE INDEX idx_airdrop_jobs_migrated ON airdrop_jobs (migrated_to_queue, status);
