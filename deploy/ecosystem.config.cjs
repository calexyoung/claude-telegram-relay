/**
 * PM2 Ecosystem Config — Claude Telegram Relay
 *
 * Manages all relay services on a VPS:
 *   - telegram-bot: always-on Telegram relay
 *   - smart-checkin: proactive check-ins (every 30 min, 9am-6pm)
 *   - morning-briefing: daily morning summary (9am)
 *
 * Usage:
 *   pm2 start deploy/ecosystem.config.cjs
 *   pm2 reload deploy/ecosystem.config.cjs
 *   pm2 stop all
 *   pm2 logs
 */

const path = require("path");

const APP_DIR = path.resolve(__dirname, "..");
const BUN = process.env.BUN_PATH || "bun";

module.exports = {
  apps: [
    // ── Main Telegram Bot (always-on) ──────────────────────
    {
      name: "telegram-bot",
      interpreter: BUN,
      script: "run",
      args: "src/relay.ts",
      cwd: APP_DIR,
      autorestart: true,
      max_restarts: 10,
      min_uptime: "10s",
      restart_delay: 5000,
      exp_backoff_restart_delay: 1000,
      max_memory_restart: "512M",
      env: {
        NODE_ENV: "production",
      },
      // Graceful shutdown
      kill_timeout: 5000,
      listen_timeout: 10000,
      // Logs
      error_file: path.join(APP_DIR, "logs", "telegram-bot-error.log"),
      out_file: path.join(APP_DIR, "logs", "telegram-bot-out.log"),
      merge_logs: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
    },

    // ── Smart Check-in (every 30 min, 9am–6pm) ────────────
    {
      name: "smart-checkin",
      interpreter: BUN,
      script: "run",
      args: "examples/smart-checkin.ts",
      cwd: APP_DIR,
      autorestart: false, // cron handles scheduling
      cron_restart: "*/30 9-18 * * *", // Every 30 min, 9am-6pm
      env: {
        NODE_ENV: "production",
      },
      error_file: path.join(APP_DIR, "logs", "smart-checkin-error.log"),
      out_file: path.join(APP_DIR, "logs", "smart-checkin-out.log"),
      merge_logs: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
    },

    // ── Morning Briefing (daily at 9am) ────────────────────
    {
      name: "morning-briefing",
      interpreter: BUN,
      script: "run",
      args: "examples/morning-briefing.ts",
      cwd: APP_DIR,
      autorestart: false, // cron handles scheduling
      cron_restart: "0 9 * * *", // Daily at 9am
      env: {
        NODE_ENV: "production",
      },
      error_file: path.join(APP_DIR, "logs", "morning-briefing-error.log"),
      out_file: path.join(APP_DIR, "logs", "morning-briefing-out.log"),
      merge_logs: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
    },

    // ── Watchdog Monitor (always-on, independent) ────────────
    {
      name: "watchdog",
      interpreter: BUN,
      script: "run",
      args: "src/watchdog.ts",
      cwd: APP_DIR,
      autorestart: true,
      max_restarts: 5,
      min_uptime: "10s",
      restart_delay: 10000,
      env: {
        NODE_ENV: "production",
      },
      // Graceful shutdown
      kill_timeout: 3000,
      // Logs
      error_file: path.join(APP_DIR, "logs", "watchdog-error.log"),
      out_file: path.join(APP_DIR, "logs", "watchdog-out.log"),
      merge_logs: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
    },
  ],
};
