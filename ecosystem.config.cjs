/**
 * PM2 — queue worker (recommended for Plesk: keeps normalized worker alive across crashes/reboots).
 *
 *   npm install
 *   npm run build
 *   npm run build:worker
 *   npx pm2 start ecosystem.config.cjs
 *   npx pm2 save && npx pm2 startup
 *
 * Env is loaded inside the worker script (@next/env + dotenv); do not rely on PM2 env_file alone.
 */
const path = require("path");

const root = __dirname;

module.exports = {
  apps: [
    {
      name: "makalu-queue-worker",
      cwd: root,
      script: "dist/worker/airdrop-queue-worker.cjs",
      interpreter: "node",
      instances: 1,
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
      },
    },
  ],
};
