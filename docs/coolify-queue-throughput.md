# Coolify queue throughput settings

Safe **production starter** preset for the normalized PostgreSQL queue (`FOR UPDATE SKIP LOCKED`, optional Redis for runtime-flag cache and **cross-process** send rate limits).

## Why `npm run worker:queue` only runs one worker

That script starts **exactly one** Node.js process. To run **20–30** workers you need **20–30 processes**, each with its own DB pool and poll loop. Use either:

| Approach | How |
|----------|-----|
| **PM2 on one VM** | `npm run build && npm run build:worker`, then set `PM2_QUEUE_INSTANCES=20` (or `30`) and `npm run worker:queue:pm2`. The repo `ecosystem.config.cjs` forks N processes; `queueWorkerId()` appends PM2’s `NODE_APP_INSTANCE` to `AIRDROP_WORKER_ID` so ids stay unique (`makalu-queue-0` … `makalu-queue-19`). |
| **Coolify / Kubernetes** | Scale the **queue worker** service to **20–30 replicas** (each container runs **one** worker command). Give each replica a **unique** `AIRDROP_WORKER_ID` (e.g. from deploy metadata or `hostname`). |

Do not start 30× `npm run worker:queue` in one terminal without an orchestrator — you still only get one unless you open 30 shells or use PM2 / replicas.

## Recommended high-throughput preset (~1000 tx/min, 100 signers)

Use when you run **~100 distributor wallets** in round-robin on one chain and want about **1000 successful sends/minute** under the default **per-signer** and **global** caps.

Set on **each queue worker** process (and align **web** where noted):

| Variable | Value | Notes |
|----------|-------|--------|
| `PM2_QUEUE_INSTANCES` | `20` | Or 20 Coolify replicas; each process = one worker loop. |
| `AIRDROP_QUEUE_BATCH_SIZE` | `48` | Configured cap (max 500). Effective claim size is `min(batch_size, max_parallel_txs)`, so workers do not hoard signer slots they cannot send immediately. |
| `AIRDROP_MAX_PARALLEL_TXS` | `10` | Dashboard / DB `max_parallel_txs` up to **100**; cap simultaneous **different** signers per wave. |
| `AIRDROP_DB_CONNECTION_LIMIT` | `2` | **Per process** — 20 workers × 2 = 40 pool slots; raise Postgres `max_connections` if needed. |
| `AIRDROP_SIGNER_TXS_PER_MINUTE` | `10` | Soft cap per signer address (Redis preferred; PG fallback). |
| `AIRDROP_GLOBAL_TXS_PER_MINUTE` | `1000` | Cluster-wide cap (requires **REDIS_URL** for strict multi-process accuracy). |
| `REDIS_URL` | `redis://…` | Recommended whenever multiple workers share rate limits. |
| `AIRDROP_EMBEDDED_QUEUE_WORKER` | `false` | On **web** when dedicated `worker:queue` replicas send. |

Also set `AIRDROP_QUEUE_V2=true`, `DATABASE_URL`, and a **unique** `AIRDROP_WORKER_ID` per worker replica.

**Normalized jobs** support up to **100** distributor addresses per job; recipients are assigned **evenly** in round-robin order. **Nonce safety:** at most one `processing` row per signer at a time (partial unique index + claim SQL), plus transaction-scoped advisory locks while claiming so separate worker processes spread across signers instead of racing the same nonce. **Rate limits** apply immediately before each send (see `src/lib/queue/tx-rate-limiter.ts`).

## Recommended starter env (Coolify)

| Variable | Value | Notes |
|----------|-------|--------|
| `AIRDROP_QUEUE_BATCH_SIZE` | `48` | Configured claim cap; effective claim size follows dashboard `max_parallel_txs`. |
| `AIRDROP_QUEUE_WORKER_POLL_MS` | `500` | Delay when a poll finds nothing to claim. |
| `AIRDROP_MAX_PARALLEL_TXS` | `6` | Fallback when DB `queue_runtime_settings` is missing; prefer DB + Dashboard. |
| `AIRDROP_DB_CONNECTION_LIMIT` | `8` | **Per Node process** — see pool warning below. |
| `AIRDROP_EMBEDDED_QUEUE_WORKER` | `false` | Set on the **web** app when dedicated `worker:queue` replicas handle claims (recommended). |
| `AIRDROP_QUEUE_MAINTENANCE_INTERVAL_MS` | `30000` | Each worker runs stale-row cleanup on this interval instead of every poll. |
| `AIRDROP_TX_RATE_LIMIT_PG_CACHE_MS` | `2000` | PostgreSQL fallback cache when Redis is unset/down; use Redis for strict multi-process caps. |

## Align DB parallel cap with env

If `queue_runtime_settings` row `id = 1` still has a lower `max_parallel_txs`, raise it once:

```sql
UPDATE queue_runtime_settings SET max_parallel_txs = 10 WHERE id = 1;
```

The Dashboard “Queue worker” UI can set the same field (1–100); env `AIRDROP_MAX_PARALLEL_TXS` applies when the row is absent. **Effective parallel** per wave is still bounded by **distinct signers** in the claimed batch (nonce safety). The dashboard also reports effective claim size as `effective/configured`, for example `10/48`.

## Dashboard throughput

Queue worker → **Throughput metrics** shows active signers (pending/processing), completed tx/min (1- and 5-minute windows), failed tx/min, env caps, and **estimated_tx_per_min = active_signers × AIRDROP_SIGNER_TXS_PER_MINUTE**. A warning appears when that estimate is below `AIRDROP_TARGET_TX_PER_MINUTE` (defaults to `AIRDROP_GLOBAL_TXS_PER_MINUTE`) and at least one signer is active.

## Warnings (read before scaling)

1. **Unique worker id per replica**  
   Every queue worker container/process must use a **distinct** effective id (e.g. `queue-1`, `queue-2`, or `makalu-queue-0` … from PM2). Duplicate ids corrupt heartbeat attribution and confuse operations. With PM2 multi-instance, set one base `AIRDROP_WORKER_ID` in `ecosystem.config.cjs` and rely on the automatic `-{NODE_APP_INSTANCE}` suffix from `queueWorkerId()`.

2. **Postgres `max_connections`**  
   Total client connections ≈ **sum over all services** of `AIRDROP_DB_CONNECTION_LIMIT` (each Next.js and each worker process opens its own pool). Keep that sum **below** Postgres `max_connections` with headroom for admin/migrations.

## Scale up gradually

Increase only after stable CPU, RPC latency, and Postgres connection count. Single-signer jobs stay one on-chain send at a time per signer. `max_parallel_txs` now drives both send wave size and effective claim size, while `AIRDROP_QUEUE_BATCH_SIZE` is a safety cap above it.

| Tier | `AIRDROP_QUEUE_BATCH_SIZE` | `max_parallel_txs` (DB or env) | When |
|------|----------------------------|---------------------------------|------|
| **Safe** (starter) | 48 | 6 | Default production preset. |
| **Medium** | 48 | 10 | Healthy RPC + DB; more headroom on `max_connections`. |
| **Aggressive** | 96 | 16–100 | Proven stable at medium tier; still ≤ code caps (batch max 500, parallel max 100). |

Do not remove global pause, retries, heartbeats, or stale-processing recovery when tuning.
