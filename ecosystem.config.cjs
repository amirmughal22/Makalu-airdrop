/**
 * PM2 — one **logical** app, **N forked processes** (each is a full queue worker with SKIP LOCKED).
 *
 * `npm run worker:queue` only ever starts **one** Node process. For 20–30 workers use PM2 (or Coolify
 * replicas), not repeated `npm run worker:queue` in one shell.
 *
 *   npm install
 *   npm run build && npm run build:worker
 *   set PM2_QUEUE_INSTANCES=20   # Windows; Linux: export PM2_QUEUE_INSTANCES=20
 *   npx pm2 start ecosystem.config.cjs
 *   npx pm2 save && npx pm2 startup
 *
 * Each fork gets a unique worker id: `AIRDROP_WORKER_ID` + `-` + `NODE_APP_INSTANCE` (see `queueWorkerId()`).
 * Watch Postgres `max_connections` vs (instances × AIRDROP_DB_CONNECTION_LIMIT) + web app pools.
 *
 * Env is loaded inside the worker script (@next/env + dotenv); do not rely on PM2 env_file alone.
 */
const path = require("path");

const root = __dirname;

const n = Number.parseInt(process.env.PM2_QUEUE_INSTANCES ?? "4", 10);
const instances = Number.isFinite(n) ? Math.min(64, Math.max(1, Math.floor(n))) : 4;

module.exports = {
  apps: [
    {
      name: "makalu-queue-worker",
      cwd: root,
      script: "dist/worker/airdrop-queue-worker.cjs",
      interpreter: "node",
      instances,
      exec_mode: "fork",
      autorestart: true,
      max_restarts: 50,
      min_uptime: "10s",
      exp_backoff_restart_delay: 2000,
      max_memory_restart: "600M",
      error_file: path.join(root, "logs/pm2-worker-error.log"),
      out_file: path.join(root, "logs/pm2-worker-out.log"),
      merge_logs: true,
      time: true,
      watch: false,
      kill_timeout: 30_000,
      listen_timeout: 0,
      env: {
        NODE_ENV: "production",
        /** Base name; PM2 appends NODE_APP_INSTANCE → makalu-queue-0 … makalu-queue-19 */
        AIRDROP_WORKER_ID: "makalu-queue",
      },
    },
  ],
};
