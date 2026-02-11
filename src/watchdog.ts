/**
 * Watchdog Monitor — Claude Telegram Relay
 *
 * Standalone process that monitors the bot's health and alerts
 * via Telegram if something is wrong. Runs independently so it
 * can detect and report bot crashes.
 *
 * Monitors:
 * - /health endpoint availability (every 60s)
 * - Process memory usage (alerts if >512MB)
 * - Response time (alerts if health check >5s)
 * - Last message time (alerts if silent >2 hours during business hours)
 * - Error rate from Supabase logs
 *
 * Run: bun run src/watchdog.ts
 * Or via PM2: see deploy/ecosystem.config.cjs
 */

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const CHAT_ID = process.env.TELEGRAM_USER_ID || "";
const HEALTH_PORT = parseInt(process.env.HEALTH_PORT || "3000");
const HEALTH_URL = `http://localhost:${HEALTH_PORT}/health`;
const CHECK_INTERVAL_MS = 60_000; // 1 minute
const MEMORY_LIMIT_MB = 512;
const SILENCE_ALERT_HOURS = 2;
const BUSINESS_HOUR_START = 9;
const BUSINESS_HOUR_END = 18;

interface HealthResponse {
  status: string;
  uptime: number;
  timestamp: string;
  sessionId: string | null;
  lastProvider: string;
  fallbackEnabled: boolean;
  forumMode: boolean;
  version?: string;
  memory?: { rss: number; heapUsed: number };
  lastMessageAt?: string;
  services?: Record<string, string>;
}

interface WatchdogState {
  consecutiveFailures: number;
  lastAlertTime: number;
  lastHealthy: string;
  alertCooldownMs: number;
}

const state: WatchdogState = {
  consecutiveFailures: 0,
  lastAlertTime: 0,
  lastHealthy: new Date().toISOString(),
  alertCooldownMs: 300_000, // 5 min between alerts
};

// ── Alert via Telegram ───────────────────────────────────────

async function sendAlert(message: string): Promise<void> {
  // Cooldown: don't spam alerts
  if (Date.now() - state.lastAlertTime < state.alertCooldownMs) return;

  if (!BOT_TOKEN || !CHAT_ID) {
    console.error(`[ALERT] ${message}`);
    return;
  }

  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text: `[Watchdog] ${message}`,
      }),
    });
    state.lastAlertTime = Date.now();
  } catch {
    console.error(`[ALERT] Failed to send: ${message}`);
  }
}

// ── Health check ─────────────────────────────────────────────

async function checkHealth(): Promise<void> {
  const startTime = Date.now();

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    const res = await fetch(HEALTH_URL, { signal: controller.signal });
    clearTimeout(timeout);

    const responseTime = Date.now() - startTime;

    if (!res.ok) {
      state.consecutiveFailures++;
      if (state.consecutiveFailures >= 3) {
        await sendAlert(`Health endpoint returned ${res.status} (${state.consecutiveFailures} consecutive failures)`);
      }
      return;
    }

    const health = (await res.json()) as HealthResponse;

    // Reset failure counter
    if (state.consecutiveFailures > 0) {
      console.log(`[OK] Bot recovered after ${state.consecutiveFailures} failures`);
    }
    state.consecutiveFailures = 0;
    state.lastHealthy = new Date().toISOString();

    // Check response time
    if (responseTime > 5000) {
      await sendAlert(`Health check slow: ${responseTime}ms (threshold: 5000ms)`);
    }

    // Check memory (if enhanced health endpoint provides it)
    if (health.memory?.rss) {
      const rssMB = Math.round(health.memory.rss / 1024 / 1024);
      if (rssMB > MEMORY_LIMIT_MB) {
        await sendAlert(`High memory usage: ${rssMB}MB (limit: ${MEMORY_LIMIT_MB}MB). Consider restarting.`);
      }
    }

    // Check last message time (during business hours)
    if (health.lastMessageAt) {
      const lastMsg = new Date(health.lastMessageAt);
      const now = new Date();
      const hour = now.getHours();
      const silenceHours = (now.getTime() - lastMsg.getTime()) / (1000 * 60 * 60);

      if (
        hour >= BUSINESS_HOUR_START &&
        hour < BUSINESS_HOUR_END &&
        silenceHours > SILENCE_ALERT_HOURS
      ) {
        await sendAlert(`No messages in ${silenceHours.toFixed(1)} hours (during business hours)`);
      }
    }

    // Log status periodically
    const uptimeHrs = (health.uptime / 3600).toFixed(1);
    const memInfo = health.memory?.rss
      ? ` | ${Math.round(health.memory.rss / 1024 / 1024)}MB`
      : "";
    console.log(
      `[OK] uptime=${uptimeHrs}h | provider=${health.lastProvider} | ${responseTime}ms${memInfo}`,
    );
  } catch (err) {
    state.consecutiveFailures++;

    if (state.consecutiveFailures >= 3) {
      const message =
        err instanceof Error && err.name === "AbortError"
          ? "Health check timed out (10s)"
          : `Health endpoint unreachable: ${err instanceof Error ? err.message : String(err)}`;
      await sendAlert(`${message} (${state.consecutiveFailures} consecutive failures)`);
    }
  }
}

// ── Error rate check from Supabase ───────────────────────────

async function checkErrorRate(): Promise<void> {
  const supaUrl = process.env.SUPABASE_URL;
  const supaKey = process.env.SUPABASE_ANON_KEY;

  if (!supaUrl || !supaKey || supaUrl.includes("your_")) return;

  try {
    // Count errors in the last hour
    const oneHourAgo = new Date(Date.now() - 3600_000).toISOString();
    const res = await fetch(
      `${supaUrl}/rest/v1/logs?select=id&level=eq.error&created_at=gte.${oneHourAgo}`,
      {
        headers: {
          apikey: supaKey,
          Authorization: `Bearer ${supaKey}`,
          Prefer: "count=exact",
        },
      },
    );

    const countHeader = res.headers.get("content-range");
    if (countHeader) {
      const match = countHeader.match(/\/(\d+)/);
      const errorCount = match ? parseInt(match[1]) : 0;

      if (errorCount > 10) {
        await sendAlert(`High error rate: ${errorCount} errors in the last hour`);
      }
    }
  } catch {
    // Supabase check is best-effort
  }
}

// ── Main loop ────────────────────────────────────────────────

async function main() {
  console.log("Watchdog starting...");
  console.log(`  Health URL: ${HEALTH_URL}`);
  console.log(`  Check interval: ${CHECK_INTERVAL_MS / 1000}s`);
  console.log(`  Memory limit: ${MEMORY_LIMIT_MB}MB`);
  console.log(`  Alert cooldown: ${state.alertCooldownMs / 1000}s`);
  console.log("");

  if (!BOT_TOKEN || !CHAT_ID) {
    console.warn("Warning: TELEGRAM_BOT_TOKEN or TELEGRAM_USER_ID not set — alerts will only go to console");
  }

  // Initial check
  await checkHealth();

  // Periodic checks
  setInterval(async () => {
    await checkHealth();
  }, CHECK_INTERVAL_MS);

  // Error rate check every 15 minutes
  setInterval(async () => {
    await checkErrorRate();
  }, 900_000);
}

main();
