#!/usr/bin/env bash
# scripts/dev-all.sh — Docker 위에서 server + web 동시 기동
set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  echo "[dev:all] ERROR: .env not found."
  echo "[dev:all] Run 'pnpm run setup' first."
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "[dev:all] ERROR: docker not found in PATH."
  exit 1
fi

echo "[dev:all] Starting server + web on Docker (Ctrl-C to stop) ..."
exec docker compose up --build
