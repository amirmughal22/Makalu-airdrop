-- Optional: run if you manage schema outside `ensureQueueJobsSchema` (app startup).
-- One in-flight `processing` row per normalized signer address (nonce safety across workers).

-- Fix legacy duplicates (multiple `processing` rows for the same signer) before CREATE UNIQUE INDEX.
WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY lower(trim(signer_address))
           ORDER BY id ASC
         ) AS rn
  FROM job_wallets
  WHERE status = 'processing'
    AND signer_address IS NOT NULL
    AND length(trim(signer_address)) > 0
)
UPDATE job_wallets jw
SET status = 'pending',
    assigned_worker = NULL,
    updated_at = NOW()
FROM ranked r
WHERE jw.id = r.id AND r.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS idx_job_wallets_one_processing_per_signer
  ON job_wallets (lower(trim(signer_address)))
  WHERE status = 'processing' AND signer_address IS NOT NULL AND length(trim(signer_address)) > 0;

CREATE INDEX IF NOT EXISTS idx_job_wallets_completed_recent
  ON job_wallets (updated_at DESC) WHERE status = 'completed';

CREATE INDEX IF NOT EXISTS idx_job_wallets_failed_recent
  ON job_wallets (updated_at DESC) WHERE status = 'failed';
