-- Generated wallet batches (Dashboard) + per-wallet rows for large airdrop recipient lists.
-- Applied at runtime via ensureGeneratedWalletTables; this file is the canonical DDL reference.

CREATE TABLE IF NOT EXISTS generated_wallet_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner VARCHAR(66) NOT NULL,
  name TEXT NOT NULL,
  total_wallets INT NOT NULL,
  inserted_wallets INT NOT NULL DEFAULT 0,
  status VARCHAR(32) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ NULL,
  error TEXT NULL
);

CREATE TABLE IF NOT EXISTS generated_wallets (
  id BIGSERIAL PRIMARY KEY,
  batch_id UUID NOT NULL REFERENCES generated_wallet_batches(id) ON DELETE CASCADE,
  wallet_index INT NOT NULL,
  address VARCHAR(66) NOT NULL,
  private_key_encrypted TEXT NULL,
  mnemonic_encrypted TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_generated_wallets_batch_idx UNIQUE (batch_id, wallet_index)
);

CREATE INDEX IF NOT EXISTS idx_generated_wallets_batch_index ON generated_wallets (batch_id, wallet_index);
CREATE INDEX IF NOT EXISTS idx_generated_wallets_address_lower ON generated_wallets (lower(address));
CREATE INDEX IF NOT EXISTS idx_generated_batches_owner_created ON generated_wallet_batches (owner, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_generated_batches_status_created ON generated_wallet_batches (status, created_at);
