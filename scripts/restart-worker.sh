#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
mkdir -p "$ROOT/logs"

if command -v pm2 >/dev/null 2>&1; then
  exec pm2 restart makalu-queue-worker
fi

echo "[restart-worker] pm2 not installed — stop the foreground worker manually and run ./scripts/start-worker.sh"
