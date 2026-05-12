-- Normalized queue jobs schema (MySQL 8+ / MariaDB 10.6+ with SKIP LOCKED).
-- Run manually or via app bootstrap (see src/lib/mysql.ts).

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS jobs (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  owner VARCHAR(66) NOT NULL,
  name VARCHAR(255) NULL,
  status VARCHAR(32) NOT NULL,
  total_wallets INT UNSIGNED NOT NULL DEFAULT 0,
  processed_wallets INT UNSIGNED NOT NULL DEFAULT 0,
  failed_wallets INT UNSIGNED NOT NULL DEFAULT 0,
  mode VARCHAR(16) NOT NULL DEFAULT 'native',
  token_address VARCHAR(42) NULL,
  chain_id INT NULL,
  paused TINYINT(1) NOT NULL DEFAULT 0,
  scheduled_at DATETIME(3) NULL,
  queued_at DATETIME(3) NULL,
  target_run_count INT UNSIGNED NOT NULL DEFAULT 1,
  current_run INT UNSIGNED NOT NULL DEFAULT 1,
  loop_forever TINYINT(1) NOT NULL DEFAULT 0,
  signer_address VARCHAR(66) NULL,
  signer_addresses_json JSON NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  INDEX idx_jobs_owner_created (owner, created_at),
  INDEX idx_jobs_status_queue (status, paused, scheduled_at, queued_at, created_at),
  INDEX idx_jobs_running_updated (status, updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS job_wallets (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  job_id VARCHAR(64) NOT NULL,
  wallet_address VARCHAR(66) NOT NULL,
  private_key VARBINARY(128) NULL,
  amount VARCHAR(128) NOT NULL,
  status ENUM('pending','processing','completed','failed') NOT NULL DEFAULT 'pending',
  assigned_worker VARCHAR(64) NULL,
  tx_hash VARCHAR(128) NULL,
  rpc_url VARCHAR(512) NULL,
  retry_count INT UNSIGNED NOT NULL DEFAULT 0,
  error_message TEXT NULL,
  signer_address VARCHAR(66) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_job_wallets_job FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE,
  INDEX idx_job_wallets_job_status (job_id, status),
  INDEX idx_job_wallets_status (status),
  INDEX idx_job_wallets_worker (assigned_worker)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
