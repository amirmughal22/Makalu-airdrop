#!/usr/bin/env bash
# One-shot production bootstrap: install deps, build Next app, (re)start PM2 queue worker.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "[production-start] Project: $ROOT"

if [[ ! -f "$ROOT/package.json" ]]; then
  echo "[production-start] ERROR: package.json not found"
  exit 1
fi

if [[ ! -f "$ROOT/.env" ]] && [[ -z "${DATABASE_URL:-}" ]]; then
  echo "[production-start] WARN: No .env file and DATABASE_URL not set — DB worker will fail until configured."
fi

echo "[production-start] npm ci / install..."
npm ci 2>/dev/null || npm install

echo "[production-start] npm run build..."
npm run build

echo "[production-start] npm run build:worker (PM2 uses dist worker, not tsx)..."
npm run build:worker
npm run verify:worker

mkdir -p "$ROOT/logs"

if ! command -v pm2 >/dev/null 2>&1; then
  echo "[production-start] WARN: pm2 not found. Install: npm i -g pm2 OR npm install (local bin npx pm2)."
fi

if command -v pm2 >/dev/null 2>&1; then
  echo "[production-start] PM2 (re)start makalu-queue-worker..."
  pm2 start ecosystem.config.cjs --only makalu-queue-worker 2>/dev/null || pm2 reload ecosystem.config.cjs --only makalu-queue-worker
  pm2 save 2>/dev/null || true
  pm2 status
else
  echo "[production-start] Skipping PM2 — start worker manually: npm run worker:queue"
fi

echo "[production-start] Done."
