#!/usr/bin/env bash
#
# Deployment Script — Claude Telegram Relay
#
# Pulls latest code, installs dependencies, reloads PM2 services,
# and verifies the health endpoint.
#
# Usage:
#   bash deploy/deploy.sh              # from the app directory
#   ssh deploy@vps 'cd ~/apps/telegram-bot && bash deploy/deploy.sh'
#
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "${APP_DIR}"

export PATH="$HOME/.bun/bin:$PATH"

echo "── Deploying Claude Telegram Relay ──"
echo "  Dir: ${APP_DIR}"
echo "  Time: $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
echo ""

# ── 1. Pull latest code ────────────────────────────────────
echo "[1/4] Pulling latest code..."
git pull origin main

# ── 2. Install dependencies ─────────────────────────────────
echo "[2/4] Installing dependencies..."
bun install

# ── 3. Reload PM2 services ─────────────────────────────────
echo "[3/4] Reloading services..."
if pm2 list | grep -q "telegram-bot"; then
  pm2 reload deploy/ecosystem.config.cjs
else
  pm2 start deploy/ecosystem.config.cjs
fi
pm2 save

# ── 4. Verify health endpoint ──────────────────────────────
echo "[4/4] Verifying health..."
sleep 3

HEALTH_PORT="${HEALTH_PORT:-3000}"
if curl -sf "http://localhost:${HEALTH_PORT}/health" > /dev/null 2>&1; then
  echo ""
  echo "Health check passed:"
  curl -s "http://localhost:${HEALTH_PORT}/health" | python3 -m json.tool 2>/dev/null \
    || curl -s "http://localhost:${HEALTH_PORT}/health"
  echo ""
  echo "Deploy successful!"
else
  echo ""
  echo "WARNING: Health check failed. Checking PM2 status..."
  pm2 status
  echo ""
  echo "Attempting restart..."
  pm2 restart telegram-bot
  sleep 3
  if curl -sf "http://localhost:${HEALTH_PORT}/health" > /dev/null 2>&1; then
    echo "Health check passed after restart."
  else
    echo "Health check still failing. Check logs: pm2 logs telegram-bot"
    exit 1
  fi
fi
