import type { Pool } from "mysql2/promise";

/** Matches migrations/002_normalized_queue_jobs.sql — applied at pool startup. */
export async function ensureQueueJobsSchema(pool: Pool): Promise<void> {
  await pool.query(`
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

  await pool.query(`
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
  next_attempt_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_job_wallets_job FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE,
  INDEX idx_job_wallets_job_status (job_id, status),
  INDEX idx_job_wallets_job_wallet (job_id, wallet_address),
  INDEX idx_job_wallets_job_tx (job_id, tx_hash),
  INDEX idx_job_wallets_status (status),
  INDEX idx_job_wallets_worker (assigned_worker),
  INDEX idx_job_wallets_pending_claim (status, next_attempt_at, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

  await ignoreMysqlCodes(
    () => pool.query("ALTER TABLE job_wallets ADD COLUMN rpc_url VARCHAR(512) NULL"),
    ["ER_DUP_FIELDNAME"],
  );

  await ignoreMysqlCodes(
    () =>
      pool.query(
        "ALTER TABLE job_wallets ADD INDEX idx_job_wallets_job_wallet (job_id, wallet_address(42))",
      ),
    ["ER_DUP_KEYNAME"],
  );
  await ignoreMysqlCodes(
    () => pool.query("ALTER TABLE job_wallets ADD INDEX idx_job_wallets_job_tx (job_id, tx_hash)"),
    ["ER_DUP_KEYNAME"],
  );

  await ignoreMysqlCodes(
    () => pool.query("ALTER TABLE jobs ADD COLUMN loop_forever TINYINT(1) NOT NULL DEFAULT 0"),
    ["ER_DUP_FIELDNAME"],
  );

  await ignoreMysqlCodes(
    () =>
      pool.query(
        "ALTER TABLE job_wallets ADD COLUMN next_attempt_at DATETIME(3) NULL COMMENT 'Backoff before row can be claimed again'",
      ),
    ["ER_DUP_FIELDNAME"],
  );

  await ignoreMysqlCodes(
    () =>
      pool.query(
        "ALTER TABLE job_wallets ADD INDEX idx_job_wallets_pending_claim (status, next_attempt_at, id)",
      ),
    ["ER_DUP_KEYNAME"],
  );

  await pool.query(`
CREATE TABLE IF NOT EXISTS queue_worker_heartbeats (
  worker_id VARCHAR(64) NOT NULL PRIMARY KEY,
  hostname VARCHAR(255) NULL,
  active_job_id VARCHAR(64) NULL,
  last_heartbeat DATETIME(3) NOT NULL,
  iterations BIGINT UNSIGNED NOT NULL DEFAULT 0,
  rows_ok BIGINT UNSIGNED NOT NULL DEFAULT 0,
  rows_fail BIGINT UNSIGNED NOT NULL DEFAULT 0,
  last_batch_size INT UNSIGNED NOT NULL DEFAULT 0,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

  await ignoreMysqlCodes(
    () =>
      pool.query(
        "ALTER TABLE queue_worker_heartbeats ADD COLUMN active_job_id VARCHAR(64) NULL AFTER hostname",
      ),
    ["ER_DUP_FIELDNAME"],
  );

  await pool.query(`
CREATE TABLE IF NOT EXISTS queue_runtime_settings (
  id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
  processing_enabled TINYINT(1) NOT NULL DEFAULT 1,
  normalized_queue_v2 TINYINT(1) NOT NULL DEFAULT 1,
  embedded_worker TINYINT(1) NOT NULL DEFAULT 1,
  max_parallel_txs TINYINT UNSIGNED NOT NULL DEFAULT 3 COMMENT 'Dashboard 1-20; simultaneous txs per wave',
  max_concurrent_jobs TINYINT UNSIGNED NOT NULL DEFAULT 5 COMMENT 'Dashboard 1-32; legacy embedded job runner',
  embedded_worker_count TINYINT UNSIGNED NOT NULL DEFAULT 1 COMMENT 'Dashboard 1-10; concurrent embedded queue loops in this process',
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

  await ignoreMysqlCodes(
    () =>
      pool.query(
        "ALTER TABLE queue_runtime_settings ADD COLUMN normalized_queue_v2 TINYINT(1) NOT NULL DEFAULT 1 AFTER processing_enabled",
      ),
    ["ER_DUP_FIELDNAME"],
  );
  await ignoreMysqlCodes(
    () =>
      pool.query(
        "ALTER TABLE queue_runtime_settings ADD COLUMN embedded_worker TINYINT(1) NOT NULL DEFAULT 1 AFTER normalized_queue_v2",
      ),
    ["ER_DUP_FIELDNAME"],
  );
  await ignoreMysqlCodes(
    () =>
      pool.query(
        "ALTER TABLE queue_runtime_settings ADD COLUMN max_parallel_txs TINYINT UNSIGNED NOT NULL DEFAULT 3 AFTER embedded_worker",
      ),
    ["ER_DUP_FIELDNAME"],
  );
  await ignoreMysqlCodes(
    () =>
      pool.query(
        "ALTER TABLE queue_runtime_settings ADD COLUMN max_concurrent_jobs TINYINT UNSIGNED NOT NULL DEFAULT 5 AFTER max_parallel_txs",
      ),
    ["ER_DUP_FIELDNAME"],
  );
  await ignoreMysqlCodes(
    () =>
      pool.query(
        "ALTER TABLE queue_runtime_settings ADD COLUMN embedded_worker_count TINYINT UNSIGNED NOT NULL DEFAULT 1 AFTER max_concurrent_jobs",
      ),
    ["ER_DUP_FIELDNAME"],
  );

  await pool.query(
    `INSERT IGNORE INTO queue_runtime_settings (id, processing_enabled, normalized_queue_v2, embedded_worker, max_parallel_txs, max_concurrent_jobs, embedded_worker_count) VALUES (1, 1, 1, 1, 3, 5, 1)`,
  );
}

async function ignoreMysqlCodes(op: () => Promise<unknown>, codes: string[]): Promise<void> {
  try {
    await op();
  } catch (e: unknown) {
    const code = e && typeof e === "object" && "code" in e ? (e as { code: string }).code : "";
    if (!codes.includes(code)) throw e;
  }
}
