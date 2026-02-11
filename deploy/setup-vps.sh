#!/usr/bin/env bash
#
# VPS Provisioning Script — Claude Telegram Relay
#
# Sets up a fresh Ubuntu 22.04/24.04 VPS with everything needed
# to run the Telegram bot 24/7.
#
# Usage (run as root on a fresh VPS):
#   curl -fsSL https://raw.githubusercontent.com/<you>/claude-telegram-relay/main/deploy/setup-vps.sh | bash
#
# Or copy and run manually:
#   scp deploy/setup-vps.sh root@your-vps:/tmp/
#   ssh root@your-vps bash /tmp/setup-vps.sh
#
set -euo pipefail

# ── Configuration ───────────────────────────────────────────
DEPLOY_USER="${DEPLOY_USER:-deploy}"
APP_DIR="/home/${DEPLOY_USER}/apps/telegram-bot"
REPO_URL="${REPO_URL:-https://github.com/YOUR_USERNAME/claude-telegram-relay.git}"
BRANCH="${BRANCH:-main}"

echo "============================================"
echo " Claude Telegram Relay — VPS Setup"
echo "============================================"
echo ""
echo "  User:    ${DEPLOY_USER}"
echo "  App dir: ${APP_DIR}"
echo "  Repo:    ${REPO_URL}"
echo "  Branch:  ${BRANCH}"
echo ""

# ── 1. System updates ──────────────────────────────────────
echo "[1/7] Updating system packages..."
apt-get update -qq
apt-get upgrade -y -qq
apt-get install -y -qq curl git unzip build-essential

# ── 2. Create deploy user ──────────────────────────────────
echo "[2/7] Creating deploy user..."
if ! id "${DEPLOY_USER}" &>/dev/null; then
  adduser --disabled-password --gecos "" "${DEPLOY_USER}"
  # Allow deploy user to restart services
  echo "${DEPLOY_USER} ALL=(ALL) NOPASSWD: /usr/bin/systemctl restart pm2-${DEPLOY_USER}" \
    >> /etc/sudoers.d/${DEPLOY_USER}
fi

# ── 3. Install Bun ─────────────────────────────────────────
echo "[3/7] Installing Bun..."
su - "${DEPLOY_USER}" -c '
  if ! command -v bun &>/dev/null; then
    curl -fsSL https://bun.sh/install | bash
    echo "export PATH=\$HOME/.bun/bin:\$PATH" >> ~/.bashrc
  else
    echo "Bun already installed: $(bun --version)"
  fi
'

# ── 4. Install Node.js + PM2 ───────────────────────────────
echo "[4/7] Installing Node.js and PM2..."
if ! command -v node &>/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -qq nodejs
fi
npm install -g pm2

# ── 5. Install Claude Code CLI ──────────────────────────────
echo "[5/7] Installing Claude Code CLI..."
su - "${DEPLOY_USER}" -c '
  if ! command -v claude &>/dev/null; then
    npm install -g @anthropic-ai/claude-code
    echo "Claude Code installed"
  else
    echo "Claude Code already installed: $(claude --version 2>/dev/null || echo unknown)"
  fi
'

# ── 6. Clone repo and install dependencies ──────────────────
echo "[6/7] Setting up application..."
su - "${DEPLOY_USER}" -c "
  mkdir -p ~/apps
  if [ -d '${APP_DIR}' ]; then
    cd '${APP_DIR}'
    git pull origin ${BRANCH}
  else
    git clone --branch ${BRANCH} '${REPO_URL}' '${APP_DIR}'
  fi
  cd '${APP_DIR}'
  export PATH=\$HOME/.bun/bin:\$PATH
  bun install
  mkdir -p logs
"

# ── 7. Configure PM2 startup ───────────────────────────────
echo "[7/7] Configuring PM2 startup..."
# Generate startup script (survives reboot)
pm2 startup systemd -u "${DEPLOY_USER}" --hp "/home/${DEPLOY_USER}" --service-name "pm2-${DEPLOY_USER}"

echo ""
echo "============================================"
echo " Setup complete!"
echo "============================================"
echo ""
echo "Next steps:"
echo ""
echo "  1. Copy your .env file to the VPS:"
echo "     scp .env ${DEPLOY_USER}@$(hostname -I | awk '{print $1}'):${APP_DIR}/.env"
echo ""
echo "  2. Start the services:"
echo "     ssh ${DEPLOY_USER}@$(hostname -I | awk '{print $1}')"
echo "     cd ${APP_DIR}"
echo "     pm2 start deploy/ecosystem.config.cjs"
echo "     pm2 save"
echo ""
echo "  3. Verify:"
echo "     pm2 status"
echo "     curl http://localhost:3000/health"
echo ""
echo "  4. (Optional) Set up auto-deploy:"
echo "     Add VPS_HOST and VPS_USER to your GitHub repo secrets"
echo "     Push to main branch to trigger deploy"
echo ""
