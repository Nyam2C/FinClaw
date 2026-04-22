#!/usr/bin/env bash
# scripts/setup.sh — 최초 1회 환경 준비 (env 복사 + 의존성 설치 + DB 디렉터리)
set -euo pipefail

cd "$(dirname "$0")/.."

echo "[setup] 1/3 Checking .env ..."
if [ ! -f .env ]; then
  cp .env.example .env
  echo "[setup]   → .env created from .env.example"
  echo "[setup]   → Fill in: ANTHROPIC_API_KEY, DISCORD_BOT_TOKEN, DISCORD_APPLICATION_ID"
else
  echo "[setup]   → .env already exists (skipped)"
fi

echo "[setup] 2/3 Installing dependencies ..."
pnpm install

echo "[setup] 3/3 Preparing local DB dir ..."
mkdir -p "${HOME}/.finclaw"
echo "[setup]   → ${HOME}/.finclaw/ ready (used by local 'pnpm dev'; Docker uses named volume)"

echo ""
echo "[setup] Done. Next steps:"
echo "  1) Edit .env and fill in required API keys"
echo "  2) Run 'pnpm run dev:all' to start all services on Docker"
