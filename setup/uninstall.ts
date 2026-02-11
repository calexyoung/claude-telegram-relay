/**
 * Claude Telegram Relay — Uninstall
 *
 * Clean teardown of all services and data.
 *
 * Usage:
 *   bun run setup/uninstall.ts              # interactive (asks before deleting data)
 *   bun run setup/uninstall.ts --all        # remove everything including data
 *   bun run setup/uninstall.ts --services   # only stop services
 */

import { existsSync, unlinkSync, rmSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";

const PROJECT_ROOT = dirname(import.meta.dir);
const HOME = homedir();
const LAUNCH_AGENTS = join(HOME, "Library", "LaunchAgents");
const RELAY_DIR = process.env.RELAY_DIR || join(HOME, ".claude-relay");

// Colors
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

const PASS = green("✓");
const SKIP = dim("–");

const LAUNCHD_LABELS = [
  "com.claude.telegram-relay",
  "com.claude.smart-checkin",
  "com.claude.morning-briefing",
];

const PM2_SERVICES = [
  "telegram-bot",
  "smart-checkin",
  "morning-briefing",
  "watchdog",
];

// ── Stop and remove launchd services (macOS) ─────────────────

async function unloadLaunchd(): Promise<number> {
  if (process.platform !== "darwin") return 0;

  let removed = 0;

  for (const label of LAUNCHD_LABELS) {
    const plistPath = join(LAUNCH_AGENTS, `${label}.plist`);

    // Unload
    const proc = Bun.spawn(["launchctl", "unload", plistPath], {
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;

    // Remove plist file
    if (existsSync(plistPath)) {
      unlinkSync(plistPath);
      console.log(`  ${PASS} Removed ${label}`);
      removed++;
    } else {
      console.log(`  ${SKIP} ${label} (not installed)`);
    }
  }

  return removed;
}

// ── Stop PM2 services (Linux/VPS) ────────────────────────────

async function stopPM2(): Promise<number> {
  let stopped = 0;

  for (const name of PM2_SERVICES) {
    try {
      const proc = Bun.spawn(["npx", "pm2", "delete", name], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const code = await proc.exited;
      if (code === 0) {
        console.log(`  ${PASS} Stopped PM2: ${name}`);
        stopped++;
      } else {
        console.log(`  ${SKIP} PM2 ${name} (not running)`);
      }
    } catch {
      console.log(`  ${SKIP} PM2 not available`);
      break;
    }
  }

  // Save PM2 state
  if (stopped > 0) {
    const save = Bun.spawn(["npx", "pm2", "save"], { stdout: "pipe", stderr: "pipe" });
    await save.exited;
  }

  return stopped;
}

// ── Remove data directory ────────────────────────────────────

function removeDataDir(): boolean {
  if (!existsSync(RELAY_DIR)) {
    console.log(`  ${SKIP} ${RELAY_DIR} (doesn't exist)`);
    return false;
  }

  rmSync(RELAY_DIR, { recursive: true, force: true });
  console.log(`  ${PASS} Removed ${RELAY_DIR}`);
  return true;
}

// ── Remove logs directory ────────────────────────────────────

function removeLogsDir(): boolean {
  const logsDir = join(PROJECT_ROOT, "logs");
  if (!existsSync(logsDir)) {
    console.log(`  ${SKIP} logs/ (doesn't exist)`);
    return false;
  }

  rmSync(logsDir, { recursive: true, force: true });
  console.log(`  ${PASS} Removed logs/`);
  return true;
}

// ── Remove lock file ─────────────────────────────────────────

function removeLockFile(): boolean {
  const lockFile = join(RELAY_DIR, "bot.lock");
  if (existsSync(lockFile)) {
    unlinkSync(lockFile);
    console.log(`  ${PASS} Removed bot.lock`);
    return true;
  }
  return false;
}

// ── Simple prompt (Bun doesn't have readline, use process.stdin) ──

async function confirm(question: string): Promise<boolean> {
  process.stdout.write(`  ${question} (y/N) `);

  return new Promise((resolve) => {
    const onData = (data: Buffer) => {
      const answer = data.toString().trim().toLowerCase();
      process.stdin.removeListener("data", onData);
      process.stdin.pause();
      resolve(answer === "y" || answer === "yes");
    };
    process.stdin.resume();
    process.stdin.once("data", onData);
  });
}

// ── Main ─────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const removeAll = args.includes("--all");
  const servicesOnly = args.includes("--services");

  console.log("");
  console.log(bold("  Claude Telegram Relay — Uninstall"));
  console.log("");

  // 1. Stop services
  console.log(bold("  Services"));
  const launchdRemoved = await unloadLaunchd();
  const pm2Stopped = await stopPM2();

  if (launchdRemoved === 0 && pm2Stopped === 0) {
    console.log(`  ${SKIP} No services were running`);
  }

  if (servicesOnly) {
    console.log(`\n  ${green("Done!")} Services stopped.`);
    console.log("");
    process.exit(0);
  }

  // 2. Remove lock file
  console.log(`\n${bold("  Lock File")}`);
  removeLockFile();

  // 3. Remove data directory
  console.log(`\n${bold("  Data")}`);
  if (removeAll) {
    removeDataDir();
    removeLogsDir();
  } else {
    const removeData = await confirm(`Delete ${RELAY_DIR}? (sessions, temp files)`);
    if (removeData) removeDataDir();
    else console.log(`  ${SKIP} Kept ${RELAY_DIR}`);

    const removeLogs = await confirm("Delete logs/ directory?");
    if (removeLogs) removeLogsDir();
    else console.log(`  ${SKIP} Kept logs/`);
  }

  // 4. Summary
  console.log(`\n${bold("  Summary")}`);
  console.log(`  ${PASS} Services stopped and removed`);
  console.log(`  ${dim("Kept: .env, config/profile.md, Supabase tables")}`);
  console.log(`  ${dim("To also drop Supabase tables, delete them in the dashboard")}`);
  console.log(`  ${dim("To remove the project: rm -rf ${PROJECT_ROOT}")}`);
  console.log("");
}

main().catch((err) => {
  console.error(`\n  ${red("Error:")} ${err.message}`);
  process.exit(1);
});
