import type { Pool } from "pg";

/** Matches migrations/002 — applied at pool startup. */
export async function ensureQueueJobsSchema(pool: Pool): Promise<void> {
  await pool.query(`
CREATE TABLE IF NOT EXISTS jobs (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  owner VARCHAR(66) NOT NULL,
  name VARCHAR(255) NULL,
  status VARCHAR(32) NOT NULL,
  total_wallets INT NOT NULL DEFAULT 0,
  processed_wallets INT NOT NULL DEFAULT 0,
  failed_wallets INT NOT NULL DEFAULT 0,
  mode VARCHAR(16) NOT NULL DEFAULT 'native',
  token_address VARCHAR(42) NULL,
  chain_id INT NULL,
  paused BOOLEAN NOT NULL DEFAULT FALSE,
  scheduled_at TIMESTAMPTZ NULL,
  queued_at TIMESTAMPTZ NULL,
  target_run_count INT NOT NULL DEFAULT 1,
  current_run INT NOT NULL DEFAULT 1,
  loop_forever BOOLEAN NOT NULL DEFAULT FALSE,
  signer_address VARCHAR(66) NULL,
  signer_addresses_json JSONB NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`);

  await pool.query(`
CREATE TABLE IF NOT EXISTS job_wallets (
  id BIGSERIAL PRIMARY KEY,
  job_id VARCHAR(64) NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  wallet_address VARCHAR(66) NOT NULL,
  private_key BYTEA NULL,
  amount VARCHAR(128) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','processing','completed','failed')),
  assigned_worker VARCHAR(64) NULL,
  tx_hash VARCHAR(128) NULL,
  rpc_url VARCHAR(512) NULL,
  retry_count INT NOT NULL DEFAULT 0,
  error_message TEXT NULL,
  signer_address VARCHAR(66) NULL,
  next_attempt_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`);

  await pool.query(`ALTER TABLE job_wallets ADD COLUMN IF NOT EXISTS rpc_url VARCHAR(512) NULL`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_job_wallets_job_wallet ON job_wallets (job_id, wallet_address)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_job_wallets_job_tx ON job_wallets (job_id, tx_hash)`);
  await pool.query(`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS loop_forever BOOLEAN NOT NULL DEFAULT FALSE`);
  await pool.query(`ALTER TABLE job_wallets ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ NULL`);

  await pool.query(`
CREATE INDEX IF NOT EXISTS idx_jobs_owner_created ON jobs (owner, created_at)`);
  await pool.query(`
CREATE INDEX IF NOT EXISTS idx_jobs_status_queue ON jobs (status, paused, scheduled_at, queued_at, created_at)`);
  await pool.query(`
CREATE INDEX IF NOT EXISTS idx_jobs_running_updated ON jobs (status, updated_at)`);
  await pool.query(`
CREATE INDEX IF NOT EXISTS idx_job_wallets_job_status ON job_wallets (job_id, status)`);
  await pool.query(`
CREATE INDEX IF NOT EXISTS idx_job_wallets_status ON job_wallets (status)`);
  await pool.query(`
CREATE INDEX IF NOT EXISTS idx_job_wallets_worker ON job_wallets (assigned_worker)`);
  await pool.query(`
CREATE INDEX IF NOT EXISTS idx_job_wallets_pending_claim ON job_wallets (status, next_attempt_at, id)`);

  await pool.query(`
CREATE TABLE IF NOT EXISTS queue_worker_heartbeats (
  worker_id VARCHAR(64) NOT NULL PRIMARY KEY,
  hostname VARCHAR(255) NULL,
  active_job_id VARCHAR(64) NULL,
  last_heartbeat TIMESTAMPTZ NOT NULL,
  iterations BIGINT NOT NULL DEFAULT 0,
  rows_ok BIGINT NOT NULL DEFAULT 0,
  rows_fail BIGINT NOT NULL DEFAULT 0,
  last_batch_size INT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`);
  await ignorePgCodes(() => pool.query(`ALTER TABLE queue_worker_heartbeats ADD COLUMN IF NOT EXISTS active_job_id VARCHAR(64) NULL`), [
    "42701",
  ]);

  await pool.query(`
CREATE TABLE IF NOT EXISTS queue_runtime_settings (
  id SMALLINT NOT NULL PRIMARY KEY,
  processing_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  normalized_queue_v2 BOOLEAN NOT NULL DEFAULT TRUE,
  embedded_worker BOOLEAN NOT NULL DEFAULT TRUE,
  max_parallel_txs SMALLINT NOT NULL DEFAULT 6,
  max_concurrent_jobs SMALLINT NOT NULL DEFAULT 5,
  embedded_worker_count SMALLINT NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`);

  await ignorePgCodes(
    () => pool.query(`ALTER TABLE queue_runtime_settings ADD COLUMN IF NOT EXISTS normalized_queue_v2 BOOLEAN NOT NULL DEFAULT TRUE`),
    ["42701"],
  );
  await ignorePgCodes(
    () => pool.query(`ALTER TABLE queue_runtime_settings ADD COLUMN IF NOT EXISTS embedded_worker BOOLEAN NOT NULL DEFAULT TRUE`),
    ["42701"],
  );
  await ignorePgCodes(
    () => pool.query(`ALTER TABLE queue_runtime_settings ADD COLUMN IF NOT EXISTS max_parallel_txs SMALLINT NOT NULL DEFAULT 6`),
    ["42701"],
  );
  await ignorePgCodes(
    () =>
      pool.query(`ALTER TABLE queue_runtime_settings ADD COLUMN IF NOT EXISTS max_concurrent_jobs SMALLINT NOT NULL DEFAULT 5`),
    ["42701"],
  );
  await ignorePgCodes(
    () =>
      pool.query(
        `ALTER TABLE queue_runtime_settings ADD COLUMN IF NOT EXISTS embedded_worker_count SMALLINT NOT NULL DEFAULT 1`,
      ),
    ["42701"],
  );

  await pool.query(`
INSERT INTO queue_runtime_settings (id, processing_enabled, normalized_queue_v2, embedded_worker, max_parallel_txs, max_concurrent_jobs, embedded_worker_count)
VALUES (1, TRUE, TRUE, TRUE, 6, 5, 1)
ON CONFLICT (id) DO NOTHING`);

  await pool.query(`
CREATE OR REPLACE FUNCTION jobs_touch_updated_at() RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql`);
  await pool.query(`DROP TRIGGER IF EXISTS trg_jobs_updated_at ON jobs`);
  await pool.query(`
CREATE TRIGGER trg_jobs_updated_at
BEFORE UPDATE ON jobs FOR EACH ROW EXECUTE PROCEDURE jobs_touch_updated_at()`);

  await pool.query(`
CREATE OR REPLACE FUNCTION job_wallets_touch_updated_at() RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql`);
  await pool.query(`DROP TRIGGER IF EXISTS trg_job_wallets_updated_at ON job_wallets`);
  await pool.query(`
CREATE TRIGGER trg_job_wallets_updated_at
BEFORE UPDATE ON job_wallets FOR EACH ROW EXECUTE PROCEDURE job_wallets_touch_updated_at()`);

  await pool.query(`
CREATE OR REPLACE FUNCTION queue_worker_heartbeats_touch_updated_at() RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql`);
  await pool.query(`DROP TRIGGER IF EXISTS trg_queue_worker_heartbeats_updated_at ON queue_worker_heartbeats`);
  await pool.query(`
CREATE TRIGGER trg_queue_worker_heartbeats_updated_at
BEFORE UPDATE ON queue_worker_heartbeats FOR EACH ROW EXECUTE PROCEDURE queue_worker_heartbeats_touch_updated_at()`);

  await pool.query(`
CREATE OR REPLACE FUNCTION queue_runtime_settings_touch_updated_at() RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql`);
  await pool.query(`DROP TRIGGER IF EXISTS trg_queue_runtime_settings_updated_at ON queue_runtime_settings`);
  await pool.query(`
CREATE TRIGGER trg_queue_runtime_settings_updated_at
BEFORE UPDATE ON queue_runtime_settings FOR EACH ROW EXECUTE PROCEDURE queue_runtime_settings_touch_updated_at()`);
}

async function ignorePgCodes(op: () => Promise<unknown>, codes: string[]): Promise<void> {
  try {
    await op();
  } catch (e: unknown) {
    const code = e && typeof e === "object" && "code" in e ? String((e as { code: string }).code) : "";
    if (!codes.includes(code)) throw e;
  }
}
