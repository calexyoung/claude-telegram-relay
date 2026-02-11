/**
 * Claude Telegram Relay — Verify Setup
 *
 * Runs all health checks in sequence: env, Telegram, Supabase,
 * services, and reports overall status.
 *
 * Usage: bun run setup/verify.ts
 */

import { existsSync } from "fs";
import { join, dirname } from "path";

const PROJECT_ROOT = dirname(import.meta.dir);

// Colors
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

const PASS = green("✓");
const FAIL = red("✗");
const WARN = yellow("!");

let passed = 0;
let failed = 0;
let warned = 0;

function pass(msg: string) { console.log(`  ${PASS} ${msg}`); passed++; }
function fail(msg: string) { console.log(`  ${FAIL} ${msg}`); failed++; }
function warn(msg: string) { console.log(`  ${WARN} ${msg}`); warned++; }

// Load .env
async function loadEnv(): Promise<Record<string, string>> {
  try {
    const content = await Bun.file(join(PROJECT_ROOT, ".env")).text();
    const vars: Record<string, string> = {};
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      vars[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
    }
    return vars;
  } catch {
    return {};
  }
}

async function main() {
  console.log("");
  console.log(bold("  Claude Telegram Relay — Health Check"));
  console.log("");

  const env = await loadEnv();

  // 1. Files
  console.log(bold("  Files"));
  existsSync(join(PROJECT_ROOT, ".env")) ? pass(".env exists") : fail(".env missing — run: bun run setup");
  existsSync(join(PROJECT_ROOT, "node_modules")) ? pass("Dependencies installed") : fail("node_modules missing — run: bun install");
  existsSync(join(PROJECT_ROOT, "config", "profile.md")) ? pass("Profile configured") : warn("No profile.md — copy config/profile.example.md");

  // 2. Telegram
  console.log(`\n${bold("  Telegram")}`);
  const token = env.TELEGRAM_BOT_TOKEN || "";
  const userId = env.TELEGRAM_USER_ID || "";

  if (!token || token.includes("your_")) {
    fail("TELEGRAM_BOT_TOKEN not set");
  } else {
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
      const data = await res.json() as any;
      data.ok ? pass(`Bot: @${data.result.username}`) : fail(`Invalid token: ${data.description}`);
    } catch (e: any) {
      fail(`Telegram API unreachable: ${e.message}`);
    }
  }

  if (!userId || userId.includes("your_")) {
    fail("TELEGRAM_USER_ID not set");
  } else {
    pass(`User ID: ${userId}`);
  }

  // 3. Supabase
  console.log(`\n${bold("  Supabase")}`);
  const supaUrl = env.SUPABASE_URL || "";
  const supaKey = env.SUPABASE_ANON_KEY || "";

  if (!supaUrl || supaUrl.includes("your_")) {
    warn("SUPABASE_URL not set (memory won't persist)");
  } else if (!supaKey || supaKey.includes("your_")) {
    warn("SUPABASE_ANON_KEY not set");
  } else {
    for (const table of ["messages", "memory", "logs"]) {
      try {
        const res = await fetch(`${supaUrl}/rest/v1/${table}?select=*&limit=1`, {
          headers: { apikey: supaKey, Authorization: `Bearer ${supaKey}` },
        });
        res.status === 200 ? pass(`Table "${table}" OK`) : fail(`Table "${table}": ${res.status}`);
      } catch (e: any) {
        fail(`Supabase unreachable: ${e.message}`);
        break;
      }
    }
  }

  // 4. Services (macOS only)
  if (process.platform === "darwin") {
    console.log(`\n${bold("  Services (launchd)")}`);
    for (const label of ["com.claude.telegram-relay", "com.claude.smart-checkin", "com.claude.morning-briefing"]) {
      const proc = Bun.spawn(["launchctl", "list", label], { stdout: "pipe", stderr: "pipe" });
      const code = await proc.exited;
      code === 0 ? pass(`${label} loaded`) : warn(`${label} not loaded`);
    }
  }

  // 5. Health endpoint
  console.log(`\n${bold("  Health Endpoint")}`);
  const healthPort = env.HEALTH_PORT || "3000";
  try {
    const healthRes = await fetch(`http://localhost:${healthPort}/health`);
    if (healthRes.ok) {
      const health = await healthRes.json() as any;
      pass(`Bot running (uptime: ${Math.floor(health.uptime / 60)}m)`);
      if (health.memory?.rss) {
        const rssMB = Math.round(health.memory.rss / 1024 / 1024);
        rssMB < 512 ? pass(`Memory: ${rssMB}MB`) : warn(`Memory: ${rssMB}MB (high)`);
      }
      if (health.services) {
        for (const [svc, status] of Object.entries(health.services)) {
          status === "connected" || status === "configured"
            ? pass(`Service: ${svc}`)
            : warn(`Service: ${svc} — ${status}`);
        }
      }
    } else {
      warn(`Health endpoint returned ${healthRes.status}`);
    }
  } catch {
    warn(`Health endpoint not reachable on port ${healthPort} (bot may not be running)`);
  }

  // 6. Optional
  console.log(`\n${bold("  Optional")}`);
  env.GEMINI_API_KEY && !env.GEMINI_API_KEY.includes("your_")
    ? pass("Voice transcription (Gemini) configured")
    : warn("No GEMINI_API_KEY — voice messages won't be transcribed");

  env.ELEVENLABS_API_KEY && !env.ELEVENLABS_API_KEY.includes("your_")
    ? pass("Voice replies (ElevenLabs TTS) configured")
    : warn("No ELEVENLABS_API_KEY — voice replies disabled");

  env.ELEVENLABS_AGENT_ID && env.ELEVENLABS_PHONE_NUMBER_ID && env.USER_PHONE_NUMBER
    ? pass("Phone calls (ElevenLabs + Twilio) configured")
    : warn("Phone calls not configured (ELEVENLABS_AGENT_ID, PHONE_NUMBER_ID, USER_PHONE_NUMBER)");

  env.OPENWEATHERMAP_API_KEY && !env.OPENWEATHERMAP_API_KEY.includes("your_")
    ? pass(`Weather integration configured (${env.WEATHER_LOCATION || "no location"})`)
    : warn("No OPENWEATHERMAP_API_KEY — weather disabled");

  env.NOTION_API_KEY && !env.NOTION_API_KEY.includes("your_") && env.NOTION_DATABASE_ID
    ? pass("Notion integration configured")
    : warn("Notion not configured (NOTION_API_KEY, NOTION_DATABASE_ID)");

  env.OPENROUTER_API_KEY && !env.OPENROUTER_API_KEY.includes("your_")
    ? pass(`Fallback: OpenRouter configured (${env.OPENROUTER_MODEL || "default model"})`)
    : warn("No OPENROUTER_API_KEY — no cloud fallback");

  env.TELEGRAM_FORUM_GROUP_ID
    ? pass(`Forum agents configured (group: ${env.TELEGRAM_FORUM_GROUP_ID})`)
    : warn("No TELEGRAM_FORUM_GROUP_ID — forum agents disabled");

  env.USER_NAME && !env.USER_NAME.includes("Your ")
    ? pass(`Name: ${env.USER_NAME}`)
    : warn("USER_NAME not set in .env");

  env.USER_TIMEZONE && env.USER_TIMEZONE !== "UTC"
    ? pass(`Timezone: ${env.USER_TIMEZONE}`)
    : warn("USER_TIMEZONE is UTC — update to your local timezone");

  // Summary
  console.log(`\n${bold("  Summary")}`);
  console.log(`  ${green(`${passed} passed`)}  ${failed > 0 ? red(`${failed} failed`) : ""}  ${warned > 0 ? yellow(`${warned} warnings`) : ""}`);

  if (failed === 0) {
    console.log(`\n  ${green("Your bot is ready!")} Run: bun run start`);
  } else {
    console.log(`\n  ${red("Fix the failures above, then re-run:")} bun run setup:verify`);
  }
  console.log("");

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`\n  ${red("Error:")} ${err.message}`);
  process.exit(1);
});
