import type { Pool } from "pg";

async function ignorePgCodes(op: () => Promise<unknown>, codes: string[]): Promise<void> {
  try {
    await op();
  } catch (e: unknown) {
    const code = e && typeof e === "object" && "code" in e ? String((e as { code: string }).code) : "";
    if (!codes.includes(code)) throw e;
  }
}

/** `generated_wallet_batches` + `generated_wallets` — called from {@link getPostgresPool} bootstrap. */
export async function ensureGeneratedWalletTables(pool: Pool): Promise<void> {
  await pool.query(`
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
)`);

  await pool.query(`
CREATE TABLE IF NOT EXISTS generated_wallets (
  id BIGSERIAL PRIMARY KEY,
  batch_id UUID NOT NULL REFERENCES generated_wallet_batches(id) ON DELETE CASCADE,
  wallet_index INT NOT NULL,
  address VARCHAR(66) NOT NULL,
  private_key_encrypted TEXT NOT NULL,
  mnemonic_encrypted TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_generated_wallets_batch_idx UNIQUE (batch_id, wallet_index)
)`);

  await ignorePgCodes(
    () =>
      pool.query(
        `CREATE INDEX IF NOT EXISTS idx_generated_wallets_batch_index ON generated_wallets (batch_id, wallet_index)`,
      ),
    ["42P07"],
  );
  await ignorePgCodes(
    () =>
      pool.query(
        `CREATE INDEX IF NOT EXISTS idx_generated_wallets_address_lower ON generated_wallets (lower(address))`,
      ),
    ["42P07"],
  );
  await ignorePgCodes(
    () =>
      pool.query(
        `CREATE INDEX IF NOT EXISTS idx_generated_batches_owner_created ON generated_wallet_batches (owner, created_at DESC)`,
      ),
    ["42P07"],
  );
  await ignorePgCodes(
    () =>
      pool.query(
        `CREATE INDEX IF NOT EXISTS idx_generated_batches_status_created ON generated_wallet_batches (status, created_at)`,
      ),
    ["42P07"],
  );
}
