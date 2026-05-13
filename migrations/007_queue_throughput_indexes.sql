-- Optional: run if you manage schema outside `ensureQueueJobsSchema` (app startup).
-- One in-flight `processing` row per normalized signer address (nonce safety across workers).

CREATE UNIQUE INDEX IF NOT EXISTS idx_job_wallets_one_processing_per_signer
  ON job_wallets (lower(trim(signer_address)))
  WHERE status = 'processing' AND signer_address IS NOT NULL AND length(trim(signer_address)) > 0;

CREATE INDEX IF NOT EXISTS idx_job_wallets_completed_recent
  ON job_wallets (updated_at DESC) WHERE status = 'completed';

CREATE INDEX IF NOT EXISTS idx_job_wallets_failed_recent
  ON job_wallets (updated_at DESC) WHERE status = 'failed';
