# Wallet batches (PostgreSQL)

Large recipient lists (100k+) are stored in **`generated_wallet_batches`** and **`generated_wallets`**, then referenced when creating normalized airdrop jobs by **index range**.

## Flow

1. **Dashboard → Wallet batches** — create a batch (name + count). Status starts as `pending`.
2. Run **`npm run wallets:generate`** on the server (Coolify worker or PM2). The worker claims batches that are **`pending`** or **`running` with partial progress** (resume after crash, deploy, or Ctrl+C) using **`FOR UPDATE SKIP LOCKED`**, then takes a **per-batch PostgreSQL advisory lock** so two wallet processes never insert into the same batch concurrently. It inserts **recipient addresses only** (no private keys), updates progress, then sets status **`completed`** (or **`failed`**). Airdrops send from your **distributor** keys to those addresses.
3. **Stuck `running`?** Restart `npm run wallets:generate` — it will pick up incomplete batches. Optionally **`POST /api/airdrop/wallet-batches/{id}/resume`** (or the Dashboard **Resume** button) sets an interrupted batch to **`pending`** again for the same effect.
4. **Airdrop configuration** — choose *Saved wallets*, pick the batch, **from** / **to** indices (1-based inclusive), amount rules per tab, distributor signers, then **Create Batch Job**.

## Environment

| Variable | Purpose |
|----------|---------|
| `AUTH_SECRET` | Required for the app (sessions, JWTs, etc.). |
| `WALLET_GENERATION_BATCH_SIZE` | Rows per insert in the generator worker (default **5000**, clamp 100–5000). |
| `WALLET_GENERATION_MAX_WALLETS` | Cap on `totalWallets` when creating a batch via API (default 1_000_000). |
| `AIRDROP_DB_CONNECTION_LIMIT` | Per-process pool size for the web app and workers (default **8**). `npm run wallets:generate` uses **4** when unset after `.env` load. Keep **Σ(limit × processes) < Postgres max_connections**. |

`AIRDROP_WALLET_STORAGE_SECRET` in `.env.example` is optional (reserved for `wallet-field-crypto` helpers); **wallet batches do not store recipient private keys.**

## SQL reference

See `migrations/005_generated_wallet_batches.sql`, `migrations/006_generated_wallets_optional_private_key.sql`, and runtime DDL in `src/lib/generated-wallet-schema.ts`.

## Job creation API

`POST /api/airdrop/jobs` accepts:

- `walletSource`: `"generated_batch"`
- `generatedBatchId`: UUID string
- `fromWalletIndex`, `toWalletIndex`: integers, 1-based inclusive
- `splitMode`: `"equalTotal"` (same amount every row) or `"randomRange"` (independent random in `[minAmount, maxAmount]` per row)
- `uniformAmount`: required when `splitMode` is `"equalTotal"`
- `minAmount`, `maxAmount`: required when `splitMode` is `"randomRange"` (same semantics as the Airdrop UI min/max fields)
- `jobName` (optional)

Existing **recipient list** mode is unchanged when `walletSource` is omitted or `"recipients"`.

## Exports

- **`GET /api/airdrop/wallet-batches/{id}/export`** — CSV with `wallet_index` and `address` only.

## Related

- [Coolify queue throughput](./coolify-queue-throughput.md) — scaling `worker:queue` separately from wallet generation.
