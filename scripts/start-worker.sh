#!/usr/bin/env bash
# Start normalized queue worker with logs directory (PM2 or direct).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
mkdir -p "$ROOT/logs"

if command -v pm2 >/dev/null 2>&1; then
  exec pm2 start ecosystem.config.cjs --only makalu-queue-worker
fi

echo "[start-worker] pm2 not found — running worker in foreground (use Ctrl+C to stop)"
exec node ./node_modules/tsx/dist/cli.mjs scripts/airdrop-queue-worker.ts 2>&1 | tee -a "$ROOT/logs/worker-console.log"
