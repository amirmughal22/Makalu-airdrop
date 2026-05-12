# Wallet batches (PostgreSQL)

Large recipient lists (100k+) are stored in **`generated_wallet_batches`** and **`generated_wallets`**, then referenced when creating normalized airdrop jobs by **index range**.

## Flow

1. **Dashboard → Wallet batches** — create a batch (name + count). Status starts as `pending`.
2. Run **`npm run wallets:generate`** on the server (Coolify worker or PM2). The process claims pending batches with **`FOR UPDATE SKIP LOCKED`**, inserts keys in chunks, updates progress, then sets status **`completed`** (or **`failed`**).
3. **Airdrop configuration** — choose *Saved PostgreSQL wallet batch*, pick the batch, **from** / **to** indices (1-based inclusive), uniform amount per recipient, distributor signers, then **Create Batch Job**.

## Environment

| Variable | Purpose |
|----------|---------|
| `AIRDROP_WALLET_STORAGE_SECRET` | Preferred 32+ char secret for AES-256-GCM encryption of stored private keys. |
| `AUTH_SECRET` | Fallback key material if `AIRDROP_WALLET_STORAGE_SECRET` is unset (min 16 chars). |
| `WALLET_GENERATION_BATCH_SIZE` | Rows per insert in the generator worker (default **5000**, clamp 100–5000). |
| `WALLET_GENERATION_MAX_WALLETS` | Cap on `totalWallets` when creating a batch via API (default 1_000_000). |

## SQL reference

See `migrations/005_generated_wallet_batches.sql` and runtime DDL in `src/lib/generated-wallet-schema.ts`.

## Job creation API

`POST /api/airdrop/jobs` accepts:

- `walletSource`: `"generated_batch"`
- `generatedBatchId`: UUID string
- `fromWalletIndex`, `toWalletIndex`: integers, 1-based inclusive
- `uniformAmount`: same amount string for every `job_wallets` row
- `jobName` (optional)

Existing **recipient list** mode is unchanged when `walletSource` is omitted or `"recipients"`.

## Exports

- **Addresses only** — `GET /api/airdrop/wallet-batches/{id}/export`
- **With private keys** — same URL with `?includePrivateKeys=1` and header `x-export-private-keys: confirm` (high risk; keep files offline).

## Related

- [Coolify queue throughput](./coolify-queue-throughput.md) — scaling `worker:queue` separately from wallet generation.
