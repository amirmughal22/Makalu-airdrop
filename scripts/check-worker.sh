#!/usr/bin/env bash
# Quick health: PM2 status + last lines of worker logs.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "=== PM2 (if installed) ==="
if command -v pm2 >/dev/null 2>&1; then
  pm2 describe makalu-queue-worker 2>/dev/null || echo "(process not registered)"
else
  echo "pm2 not in PATH"
fi

echo ""
echo "=== logs/worker.log (last 15 lines) ==="
if [[ -f "$ROOT/logs/worker.log" ]]; then
  tail -n 15 "$ROOT/logs/worker.log"
else
  echo "(no worker.log yet)"
fi

echo ""
echo "=== logs/worker-error.log (last 10 lines) ==="
if [[ -f "$ROOT/logs/worker-error.log" ]]; then
  tail -n 10 "$ROOT/logs/worker-error.log"
else
  echo "(no worker-error.log yet)"
fi
