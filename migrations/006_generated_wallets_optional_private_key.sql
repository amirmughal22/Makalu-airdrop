-- Wallet batches: recipient addresses only (private keys not stored for new rows).
-- Safe to run multiple times.

ALTER TABLE generated_wallets
  ALTER COLUMN private_key_encrypted DROP NOT NULL;
