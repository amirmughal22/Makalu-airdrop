-- Production hardening: retry scheduling, claim index, worker heartbeats.
-- Applied automatically via ensureQueueJobsSchema (mysql-queue-schema.ts) on app/worker boot.

SET NAMES utf8mb4;

ALTER TABLE job_wallets
  ADD COLUMN next_attempt_at DATETIME(3) NULL
    COMMENT 'Pending rows are not claimed until this time (exponential backoff after failures).';

-- Index may already exist from bootstrap:
-- CREATE INDEX idx_job_wallets_pending_claim ON job_wallets (status, next_attempt_at, id);

CREATE TABLE IF NOT EXISTS queue_worker_heartbeats (
  worker_id VARCHAR(64) NOT NULL PRIMARY KEY,
  hostname VARCHAR(255) NULL,
  last_heartbeat DATETIME(3) NOT NULL,
  iterations BIGINT UNSIGNED NOT NULL DEFAULT 0,
  rows_ok BIGINT UNSIGNED NOT NULL DEFAULT 0,
  rows_fail BIGINT UNSIGNED NOT NULL DEFAULT 0,
  last_batch_size INT UNSIGNED NOT NULL DEFAULT 0,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
