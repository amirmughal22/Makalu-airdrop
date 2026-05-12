#!/usr/bin/env bash
# Use on servers where Plesk / cron runs npm without a login shell (nodenv: node not found).
set -euo pipefail
cd "$(dirname "$0")/.."

export PATH="${HOME}/.nodenv/shims:${HOME}/.nodenv/bin:${PATH}"
if command -v nodenv >/dev/null 2>&1; then
  eval "$(nodenv init - bash 2>/dev/null)" || true
fi

exec npm install "$@"
