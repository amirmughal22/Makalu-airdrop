# Wallet batches (PostgreSQL)

Large recipient lists (100k+) are stored in **`generated_wallet_batches`** and **`generated_wallets`**, then referenced when creating normalized airdrop jobs by **index range**.

## Flow

1. **Dashboard → Wallet batches** — create a batch (name + count). Status starts as `pending`.
2. **Materialize addresses** — by default the **Node server** runs an embedded poll loop (same logic as `npm run wallets:generate`) after `instrumentation` loads, so you do **not** need a separate wallet worker unless you turn it off. It claims batches that are **`pending`** or **`running` with partial progress** (resume after crash, deploy, or Ctrl+C) using **`FOR UPDATE SKIP LOCKED`**, then takes a **per-batch PostgreSQL advisory lock** so two processes never insert into the same batch concurrently. It inserts **recipient addresses only** (no private keys), updates progress, then sets status **`completed`** (or **`failed`**). Airdrops send from your **distributor** keys to those addresses.
   - **Opt out:** `AIRDROP_EMBEDDED_WALLET_GENERATION=false` — then run **`npm run wallets:generate`** (Coolify worker or PM2) on at least one machine with `DATABASE_URL`.
   - **Many web replicas:** each replica runs its own poller when embedded is on (usually fine; advisory lock serializes per batch). To avoid duplicate polling, disable embedded on web and run a **single** `npm run wallets:generate` process.
3. **Stuck `running`?** Restart the app or the standalone generator — incomplete batches are picked up automatically. Optionally **`POST /api/airdrop/wallet-batches/{id}/resume`** (or the Dashboard **Resume** button) sets an interrupted batch to **`pending`** again.
4. **Airdrop configuration** — choose *Saved wallets*, pick the batch, **from** / **to** indices (1-based inclusive), amount rules per tab, distributor signers, then **Create Batch Job**.

## Environment

| Variable | Purpose |
|----------|---------|
| `AUTH_SECRET` | Required for the app (sessions, JWTs, etc.). |
| `WALLET_GENERATION_BATCH_SIZE` | Rows per insert in the generator worker (default **5000**, clamp 100–5000). |
| `WALLET_GENERATION_MAX_WALLETS` | Cap on `totalWallets` when creating a batch via API (default 1_000_000). |
| `AIRDROP_DB_CONNECTION_LIMIT` | Per-process pool size for the web app and workers (default **8**). Standalone `npm run wallets:generate` uses **4** when unset after `.env` load. Keep **Σ(limit × processes) < Postgres max_connections**. |
| `AIRDROP_EMBEDDED_WALLET_GENERATION` | When not `false`, the Next.js Node server runs wallet batch materialization in-process (default **on**). Set **`false`** if you use only `npm run wallets:generate`. |
| `AIRDROP_WALLET_GEN_EMBEDDED_YIELD_MS` | Optional sleep (ms) after each insert chunk in embedded mode (default **3**, max **500**) so request handlers get CPU during huge batches. |

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

- [Coolify queue throughput](./coolify-queue-throughput.md) — scaling `worker:queue` separately from the app. Wallet batch **embedded** generation runs in each Node web process by default; with many web replicas you may set `AIRDROP_EMBEDDED_WALLET_GENERATION=false` on web and run a **single** `npm run wallets:generate` if you want one poller only.
