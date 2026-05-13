/**
 * PM2 — forked processes; each runs `npm run worker:queue:dist` (built bundle, no tsx).
 *
 *   npm install && npm run build && npm run build:worker
 *   set PM2_QUEUE_INSTANCES=20   # Windows; Linux: export PM2_QUEUE_INSTANCES=20
 *   npx pm2 start ecosystem.config.cjs
 *
 * `NODE_APP_INSTANCE` is set by PM2 per fork; npm forwards env to the child `node` process so
 * `queueWorkerId()` yields makalu-queue-0 … makalu-queue-N (see `AIRDROP_WORKER_ID` + instance).
 */
const path = require("path");

const root = __dirname;

const n = Number.parseInt(process.env.PM2_QUEUE_INSTANCES ?? "4", 10);
const instances = Number.isFinite(n) ? Math.min(64, Math.max(1, Math.floor(n))) : 4;

const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";

module.exports = {
  apps: [
    {
      name: "makalu-queue-worker",
      cwd: root,
      script: npmCmd,
      args: ["run", "worker:queue:dist"],
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
        AIRDROP_WORKER_ID: "makalu-queue",
      },
    },
  ],
};
