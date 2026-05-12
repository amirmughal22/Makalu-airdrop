# Coolify queue throughput settings

Safe **production starter** preset for the normalized PostgreSQL queue (`FOR UPDATE SKIP LOCKED`, optional Redis for runtime-flag cache).

## Why `npm run worker:queue` only runs one worker

That script starts **exactly one** Node.js process. To run **20–30** workers you need **20–30 processes**, each with its own DB pool and poll loop. Use either:

| Approach | How |
|----------|-----|
| **PM2 on one VM** | `npm run build && npm run build:worker`, then set `PM2_QUEUE_INSTANCES=20` (or `30`) and `npm run worker:queue:pm2`. The repo `ecosystem.config.cjs` forks N processes; `queueWorkerId()` appends PM2’s `NODE_APP_INSTANCE` to `AIRDROP_WORKER_ID` so ids stay unique (`makalu-queue-0` … `makalu-queue-19`). |
| **Coolify / Kubernetes** | Scale the **queue worker** service to **20–30 replicas** (each container runs **one** worker command). Give each replica a **unique** `AIRDROP_WORKER_ID` (e.g. from deploy metadata or `hostname`). |

Do not start 30× `npm run worker:queue` in one terminal without an orchestrator — you still only get one unless you open 30 shells or use PM2 / replicas.

## Recommended starter env (Coolify)

Set these on the **queue worker** service (and align the **web** app where noted):

| Variable | Value | Notes |
|----------|-------|--------|
| `AIRDROP_QUEUE_BATCH_SIZE` | `48` | Wallets claimed per claim transaction (code max 500). |
| `AIRDROP_QUEUE_WORKER_POLL_MS` | `500` | Delay when a poll finds nothing to claim. |
| `AIRDROP_MAX_PARALLEL_TXS` | `6` | Fallback when DB `queue_runtime_settings` is missing; prefer DB + SQL below. |
| `AIRDROP_DB_CONNECTION_LIMIT` | `16` | **Per Node process** — see pool warning below. |
| `AIRDROP_EMBEDDED_QUEUE_WORKER` | `false` | Set on the **web** app when dedicated `worker:queue` replicas handle claims (recommended). |

Also set `AIRDROP_QUEUE_V2=true`, `DATABASE_URL`, and a **unique** `AIRDROP_WORKER_ID` per worker replica (see warnings).

## Align DB parallel cap with env

If `queue_runtime_settings` row `id = 1` still has a lower `max_parallel_txs`, raise it once:

```sql
UPDATE queue_runtime_settings SET max_parallel_txs = 6 WHERE id = 1;
```

The Dashboard “Queue worker” UI can set the same field; env `AIRDROP_MAX_PARALLEL_TXS` applies when the row is absent or as a documented fallback—**effective parallel** is still bounded by distinct signers per batch (nonce safety).

## Warnings (read before scaling)

1. **Unique worker id per replica**  
   Every queue worker container/process must use a **distinct** effective id (e.g. `queue-1`, `queue-2`, or `makalu-queue-0` … from PM2). Duplicate ids corrupt heartbeat attribution and confuse operations. With PM2 multi-instance, set one base `AIRDROP_WORKER_ID` in `ecosystem.config.cjs` and rely on the automatic `-{NODE_APP_INSTANCE}` suffix from `queueWorkerId()`.

2. **Postgres `max_connections`**  
   Total client connections ≈ **sum over all services** of `AIRDROP_DB_CONNECTION_LIMIT` (each Next.js and each worker process opens its own pool). Keep that sum **below** Postgres `max_connections` with headroom for admin/migrations.

## Scale up gradually

Increase only after stable CPU, RPC latency, and Postgres connection count. Single-signer jobs stay one on-chain send at a time per signer; batch size mainly reduces claim round-trips; `max_parallel_txs` helps when **multiple signers** appear in one batch.

| Tier | `AIRDROP_QUEUE_BATCH_SIZE` | `max_parallel_txs` (DB or env) | When |
|------|----------------------------|---------------------------------|------|
| **Safe** (starter) | 48 | 6 | Default production preset. |
| **Medium** | 96 | 10 | Healthy RPC + DB; more headroom on `max_connections`. |
| **Aggressive** | 128 | 16 | Proven stable at medium tier; still ≤ code caps (batch max 500, parallel max 20). |

Do not remove global pause, retries, heartbeats, or stale-processing recovery when tuning.
