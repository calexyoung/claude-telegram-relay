/**
 * Claude Code Telegram Relay
 *
 * Minimal relay that connects Telegram to Claude Code CLI.
 * Customize this for your own needs.
 *
 * Run: bun run src/relay.ts
 */

import { Bot, Context, InputFile } from "grammy";
import { spawn } from "bun";
import { writeFile, mkdir, readFile, unlink } from "fs/promises";
import { join, dirname } from "path";
import { log, logError } from "./logger";
import { saveMessage, getRecentMessages, getMemoryContext, processIntents } from "./memory";
import { textToSpeech, isTTSAvailable } from "./tts";
import { extractActions, queueAction, approveAction, denyAction } from "./actions";
import { tryFallbacks, isFallbackEnabled, type ProviderResult } from "./fallback";
import {
  initAgents,
  getAgentByTopicId,
  getAgent,
  getAllAgents,
  setAgentTopicId,
  matchTopicNameToAgent,
  saveTopicMappings,
  isForumMode,
  type AgentConfig,
  type AgentSlug,
} from "./agents/registry";
import { runBoardMeeting } from "./agents/orchestrator";

const PROJECT_ROOT = dirname(dirname(import.meta.path));

// ============================================================
// CONFIGURATION
// ============================================================

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const ALLOWED_USER_ID = process.env.TELEGRAM_USER_ID || "";
const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";
const PROJECT_DIR = process.env.PROJECT_DIR || "";
const RELAY_DIR = process.env.RELAY_DIR || join(process.env.HOME || "~", ".claude-relay");
const FORUM_GROUP_ID = process.env.TELEGRAM_FORUM_GROUP_ID || "";

// Directories
const TEMP_DIR = join(RELAY_DIR, "temp");
const UPLOADS_DIR = join(RELAY_DIR, "uploads");

// Session tracking for conversation continuity (per-agent)
const SESSION_FILE = join(RELAY_DIR, "session.json");

interface AgentSession {
  sessionId: string | null;
  lastActivity: string;
}

interface SessionStore {
  // Per-agent sessions for forum mode
  agents: Record<string, AgentSession>;
  // Legacy single session for DM mode
  sessionId: string | null;
  lastActivity: string;
}

// ============================================================
// SESSION MANAGEMENT
// ============================================================

async function loadSessions(): Promise<SessionStore> {
  try {
    const content = await readFile(SESSION_FILE, "utf-8");
    const data = JSON.parse(content);
    // Migrate from old format if needed
    if (!data.agents) {
      return {
        agents: { general: { sessionId: data.sessionId, lastActivity: data.lastActivity } },
        sessionId: data.sessionId,
        lastActivity: data.lastActivity,
      };
    }
    return data;
  } catch {
    return { agents: {}, sessionId: null, lastActivity: new Date().toISOString() };
  }
}

async function saveSessions(store: SessionStore): Promise<void> {
  await writeFile(SESSION_FILE, JSON.stringify(store, null, 2));
}

function getAgentSessionId(agentSlug?: string): string | null {
  const key = agentSlug || "general";
  return sessions.agents[key]?.sessionId ?? sessions.sessionId;
}

function setAgentSessionId(agentSlug: string | undefined, sessionId: string): void {
  const key = agentSlug || "general";
  if (!sessions.agents[key]) {
    sessions.agents[key] = { sessionId: null, lastActivity: new Date().toISOString() };
  }
  sessions.agents[key].sessionId = sessionId;
  sessions.agents[key].lastActivity = new Date().toISOString();
  // Also update legacy field for DM mode
  if (!agentSlug || agentSlug === "general") {
    sessions.sessionId = sessionId;
    sessions.lastActivity = new Date().toISOString();
  }
}

let sessions = await loadSessions();

// ============================================================
// LOCK FILE (prevent multiple instances)
// ============================================================

const LOCK_FILE = join(RELAY_DIR, "bot.lock");

async function acquireLock(): Promise<boolean> {
  try {
    const existingLock = await readFile(LOCK_FILE, "utf-8").catch(() => null);

    if (existingLock) {
      const pid = parseInt(existingLock);
      try {
        process.kill(pid, 0); // Check if process exists
        console.log(`Another instance running (PID: ${pid})`);
        return false;
      } catch {
        console.log("Stale lock found, taking over...");
      }
    }

    await writeFile(LOCK_FILE, process.pid.toString());
    return true;
  } catch (error) {
    console.error("Lock error:", error);
    return false;
  }
}

async function releaseLock(): Promise<void> {
  await unlink(LOCK_FILE).catch(() => {});
}

// Cleanup on exit
process.on("exit", () => {
  try {
    require("fs").unlinkSync(LOCK_FILE);
  } catch {}
});
process.on("SIGINT", async () => {
  await releaseLock();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  await releaseLock();
  process.exit(0);
});

// ============================================================
// SETUP
// ============================================================

if (!BOT_TOKEN) {
  console.error("TELEGRAM_BOT_TOKEN not set!");
  console.log("\nTo set up:");
  console.log("1. Message @BotFather on Telegram");
  console.log("2. Create a new bot with /newbot");
  console.log("3. Copy the token to .env");
  process.exit(1);
}

// Create directories
await mkdir(TEMP_DIR, { recursive: true });
await mkdir(UPLOADS_DIR, { recursive: true });

// Acquire lock
if (!(await acquireLock())) {
  console.error("Could not acquire lock. Another instance may be running.");
  process.exit(1);
}

const bot = new Bot(BOT_TOKEN);

// ============================================================
// SECURITY: Only respond to authorized user
// ============================================================

bot.use(async (ctx, next) => {
  const userId = ctx.from?.id.toString();

  // If ALLOWED_USER_ID is set, enforce it
  if (ALLOWED_USER_ID && userId !== ALLOWED_USER_ID) {
    log("unauthorized_access", `Rejected user ${userId}`, { level: "warn" });
    await ctx.reply("This bot is private.");
    return;
  }

  await next();
});

// ============================================================
// CORE: Call Claude CLI (with fallback chain)
// ============================================================

// Track which provider served the last request
let lastProvider: ProviderResult["provider"] = "claude";

async function callClaudeCLI(
  prompt: string,
  options?: { resume?: boolean; imagePath?: string; agentSlug?: string }
): Promise<string> {
  const args = [CLAUDE_PATH, "-p", prompt];

  // Resume previous session if available and requested (per-agent)
  const currentSessionId = getAgentSessionId(options?.agentSlug);
  if (options?.resume && currentSessionId) {
    args.push("--resume", currentSessionId);
  }

  args.push("--output-format", "text");

  log("claude_called", prompt.substring(0, 80), {
    sessionId: currentSessionId || undefined,
    metadata: options?.agentSlug ? { agent: options.agentSlug } : undefined,
  });
  const startTime = Date.now();

  const proc = spawn(args, {
    stdout: "pipe",
    stderr: "pipe",
    cwd: PROJECT_DIR || undefined,
    env: {
      ...process.env,
    },
  });

  const output = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();

  const exitCode = await proc.exited;
  const durationMs = Date.now() - startTime;

  if (exitCode !== 0) {
    throw new Error(stderr || `Claude exited with code ${exitCode}`);
  }

  // Extract session ID from output if present (for --resume)
  const sessionMatch = output.match(/Session ID: ([a-f0-9-]+)/i);
  if (sessionMatch) {
    setAgentSessionId(options?.agentSlug, sessionMatch[1]);
    await saveSessions(sessions);
  }

  log("claude_response", `${output.length} chars`, {
    durationMs,
    sessionId: currentSessionId || undefined,
    metadata: options?.agentSlug ? { agent: options.agentSlug } : undefined,
  });

  return output.trim();
}

/**
 * Call Claude CLI with automatic fallback to OpenRouter/Ollama on failure.
 */
async function callClaude(
  prompt: string,
  options?: { resume?: boolean; imagePath?: string; agentSlug?: string }
): Promise<string> {
  // Try Claude CLI first
  try {
    const result = await callClaudeCLI(prompt, options);
    lastProvider = "claude";
    return result;
  } catch (error) {
    logError("claude_error", "Claude CLI failed, checking fallbacks", error);
  }

  // Claude failed — try fallback chain
  if (!isFallbackEnabled()) {
    return "Error: Claude is temporarily unavailable. No fallback providers configured.";
  }

  log("fallback_activated", "Claude CLI failed, trying fallback providers");
  const fallback = await tryFallbacks(prompt);
  lastProvider = fallback.provider;

  if (fallback.provider !== "error") {
    log("fallback_success", `Served by ${fallback.provider}`, {
      durationMs: fallback.durationMs,
      metadata: { provider: fallback.provider },
    });
  }

  return fallback.text;
}

// ============================================================
// RESPONSE PROCESSING (actions + memory intents)
// ============================================================

/**
 * Process Claude's response: extract actions, send approval buttons,
 * process memory intents, and return the cleaned text.
 */
async function processResponse(
  ctx: Context,
  response: string
): Promise<string> {
  // 1. Extract any [ACTION: ...] tags
  const { cleaned: afterActions, actions } = extractActions(response);

  // 2. Queue each action and send inline keyboard
  for (const action of actions) {
    const actionId = await queueAction(action);
    if (actionId) {
      const description = `${action.type}: ${Object.entries(action.fields).map(([k, v]) => `${k}=${v}`).join(", ")}`;
      await ctx.reply(`Action requested:\n${description}`, {
        reply_markup: {
          inline_keyboard: [[
            { text: "Approve", callback_data: `action_approve_${actionId}` },
            { text: "Deny", callback_data: `action_deny_${actionId}` },
          ]],
        },
      });
    }
  }

  // 3. Process memory intents ([REMEMBER:], [GOAL:], [DONE:])
  const cleaned = await processIntents(afterActions);

  return cleaned;
}

// ============================================================
// AGENT DETECTION HELPER
// ============================================================

/**
 * Detect which agent should handle a message based on forum topic.
 * Returns undefined for DM mode or unrecognized topics.
 */
function detectAgent(ctx: Context): AgentConfig | undefined {
  const threadId = (ctx.message as any)?.message_thread_id as number | undefined;
  if (!threadId) return undefined;
  return getAgentByTopicId(threadId);
}

// ============================================================
// COMMANDS
// ============================================================

// /board — Run a board meeting (all agents weigh in)
bot.command("board", async (ctx) => {
  const question = ctx.match?.trim();
  if (!question) {
    await ctx.reply("Usage: /board <your question>\n\nAll specialist agents will weigh in and a synthesis will be provided.");
    return;
  }

  log("board_meeting_requested", question.substring(0, 80));
  await ctx.replyWithChatAction("typing");

  saveMessage("user", `[Board Meeting] ${question}`);

  // Run board meeting — pass a simple callClaude wrapper
  const result = await runBoardMeeting(
    question,
    (prompt) => callClaude(prompt),
    profileContext || undefined,
  );

  // Post each agent's response
  const chatId = ctx.chat.id;
  for (const agentResp of result.responses) {
    const topicId = agentResp.agent.topicId;
    const header = `[${agentResp.agent.name}]`;
    const text = `${header}\n\n${agentResp.response}`;

    if (topicId) {
      // Post to agent's forum topic
      await sendLongMessage(ctx.api, chatId, text, topicId);
    }
  }

  // Post synthesis to the current thread (General topic or DM)
  const threadId = (ctx.message as any)?.message_thread_id as number | undefined;
  const synthesisText = `Board Meeting Summary\n\n${result.synthesis}\n\n(${result.responses.length} agents consulted in ${(result.totalDurationMs / 1000).toFixed(1)}s)`;

  if (threadId) {
    await sendLongMessage(ctx.api, chatId, synthesisText, threadId);
  } else {
    await sendResponse(ctx, synthesisText);
  }

  // Provide inline keyboard to pick an agent for follow-up
  const agentButtons = result.responses
    .filter((r) => !r.error)
    .map((r) => ({
      text: r.agent.name,
      callback_data: `agent_followup_${r.agent.slug}`,
    }));

  if (agentButtons.length > 0) {
    const replyOpts: Record<string, unknown> = {
      reply_markup: {
        inline_keyboard: [agentButtons.slice(0, 3), agentButtons.slice(3)].filter((row) => row.length > 0),
      },
    };
    if (threadId) replyOpts.message_thread_id = threadId;
    await ctx.api.sendMessage(chatId, "Follow up with a specific agent:", replyOpts as any);
  }

  saveMessage("assistant", `[Board Meeting Summary] ${result.synthesis}`);
});

// /setup_topics — Create forum topics for each agent (run once in a forum group)
bot.command("setup_topics", async (ctx) => {
  const chatId = ctx.chat.id;

  // Check if this is a forum-enabled group
  const chat = await ctx.api.getChat(chatId);
  if (!("is_forum" in chat) || !(chat as any).is_forum) {
    await ctx.reply("This command only works in a group with Forum Topics enabled.\n\n1. Create a Telegram group\n2. Enable Forum Topics in group settings\n3. Add the bot as admin\n4. Run /setup_topics");
    return;
  }

  log("setup_topics_start", `Setting up forum topics in chat ${chatId}`);
  await ctx.reply("Creating agent topics...");

  const agents = getAllAgents();
  let created = 0;

  for (const agent of agents) {
    try {
      const topic = await ctx.api.createForumTopic(chatId, agent.name);
      setAgentTopicId(agent.slug as AgentSlug, topic.message_thread_id);
      created++;
      log("topic_created", `${agent.name}: topic ${topic.message_thread_id}`);
    } catch (err) {
      logError("topic_create_error", `Failed to create topic for ${agent.name}`, err);
    }
  }

  await saveTopicMappings();
  await ctx.reply(`Created ${created}/${agents.length} agent topics. Mapping saved to config/agents.json.\n\nSet TELEGRAM_FORUM_GROUP_ID=${chatId} in your .env file.`);
});

// ============================================================
// MESSAGE HANDLERS
// ============================================================

// Text messages
bot.on("message:text", async (ctx) => {
  const text = ctx.message.text;

  // Detect which agent should handle this (forum topic routing)
  const agent = detectAgent(ctx);
  const agentSlug = agent?.slug;

  log("message_received", text.substring(0, 80), {
    metadata: { type: "text", agent: agentSlug || "general" },
  });

  await ctx.replyWithChatAction("typing");

  // Save user message to memory
  saveMessage("user", text, agentSlug ? { agent: agentSlug } : undefined);

  const enrichedPrompt = await buildPrompt(text, agent);

  const response = await callClaude(enrichedPrompt, { resume: true, agentSlug });

  // Process actions + memory intents, save assistant response
  const cleaned = await processResponse(ctx, response);
  saveMessage("assistant", cleaned, agentSlug ? { agent: agentSlug } : undefined);

  await sendResponse(ctx, cleaned);
});

// Voice messages (transcription via Google Gemini)
bot.on("message:voice", async (ctx) => {
  log("message_received", "Voice message", { metadata: { type: "voice" } });
  await ctx.replyWithChatAction("typing");

  const geminiKey = process.env.GEMINI_API_KEY;
  if (!geminiKey) {
    await ctx.reply("Voice transcription requires GEMINI_API_KEY in .env");
    return;
  }

  try {
    // 1. Download the voice file
    const file = await ctx.api.getFile(ctx.message.voice.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
    const audioResponse = await fetch(fileUrl);
    const audioBuffer = Buffer.from(await audioResponse.arrayBuffer());
    const base64Audio = audioBuffer.toString("base64");

    // 2. Send to Gemini for transcription
    const geminiResponse = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${geminiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{
            parts: [
              { text: "Transcribe this audio message exactly. Return only the transcription, no commentary." },
              { inline_data: { mime_type: "audio/ogg", data: base64Audio } },
            ],
          }],
        }),
      }
    );

    const geminiResult = await geminiResponse.json() as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const transcription = geminiResult.candidates?.[0]?.content?.parts?.[0]?.text?.trim();

    if (!transcription) {
      await ctx.reply("Could not transcribe the voice message.");
      return;
    }

    log("voice_transcribed", transcription.substring(0, 80));

    // Save transcription to memory
    saveMessage("user", `[Voice]: ${transcription}`);

    // 3. Pass transcription to Claude
    const enrichedPrompt = await buildPrompt(`[Voice message]: ${transcription}`);
    const response = await callClaude(enrichedPrompt, { resume: true });

    // Process actions + memory intents, save assistant response
    const cleaned = await processResponse(ctx, response);
    saveMessage("assistant", cleaned);

    // 4. Try voice reply if TTS is available
    if (isTTSAvailable()) {
      const audio = await textToSpeech(cleaned);
      if (audio) {
        await ctx.replyWithVoice(new InputFile(audio, "response.mp3"));
        // Also send text for accessibility
        await sendResponse(ctx, cleaned);
        return;
      }
    }

    // Fallback to text
    await sendResponse(ctx, cleaned);
  } catch (err) {
    logError("voice_error", "Voice transcription failed", err);
    await ctx.reply("Failed to process voice message. Please try again.");
  }
});

// Photos/Images
bot.on("message:photo", async (ctx) => {
  log("message_received", "Image", { metadata: { type: "photo" } });
  await ctx.replyWithChatAction("typing");

  try {
    const photos = ctx.message.photo;
    const photo = photos[photos.length - 1];
    const file = await ctx.api.getFile(photo.file_id);

    const timestamp = Date.now();
    const filePath = join(UPLOADS_DIR, `image_${timestamp}.jpg`);

    const response = await fetch(
      `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`
    );
    const buffer = await response.arrayBuffer();
    await writeFile(filePath, Buffer.from(buffer));

    const caption = ctx.message.caption || "Analyze this image.";
    const prompt = `[Image: ${filePath}]\n\n${caption}`;

    saveMessage("user", `[Image] ${caption}`);

    const claudeResponse = await callClaude(prompt, { resume: true });
    const cleaned = await processResponse(ctx, claudeResponse);
    saveMessage("assistant", cleaned);

    await unlink(filePath).catch(() => {});
    await sendResponse(ctx, cleaned);
  } catch (error) {
    logError("image_error", "Could not process image", error);
    await ctx.reply("Could not process image.");
  }
});

// Documents
bot.on("message:document", async (ctx) => {
  const doc = ctx.message.document;
  log("message_received", `Document: ${doc.file_name}`, { metadata: { type: "document" } });
  await ctx.replyWithChatAction("typing");

  try {
    const file = await ctx.getFile();
    const timestamp = Date.now();
    const fileName = doc.file_name || `file_${timestamp}`;
    const filePath = join(UPLOADS_DIR, `${timestamp}_${fileName}`);

    const response = await fetch(
      `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`
    );
    const buffer = await response.arrayBuffer();
    await writeFile(filePath, Buffer.from(buffer));

    const caption = ctx.message.caption || `Analyze: ${doc.file_name}`;
    const prompt = `[File: ${filePath}]\n\n${caption}`;

    saveMessage("user", `[Document: ${doc.file_name}] ${caption}`);

    const claudeResponse = await callClaude(prompt, { resume: true });
    const cleaned = await processResponse(ctx, claudeResponse);
    saveMessage("assistant", cleaned);

    await unlink(filePath).catch(() => {});
    await sendResponse(ctx, cleaned);
  } catch (error) {
    logError("document_error", "Could not process document", error);
    await ctx.reply("Could not process document.");
  }
});

// ============================================================
// CALLBACK QUERIES (inline button responses)
// ============================================================

bot.callbackQuery(/^action_(approve|deny)_(.+)$/, async (ctx) => {
  const decision = ctx.match[1]; // "approve" or "deny"
  const actionId = ctx.match[2];

  log("action_callback", `${decision} action ${actionId}`);

  if (decision === "approve") {
    const result = await approveAction(actionId);
    if (result.success) {
      await ctx.editMessageText(`Approved: ${result.description}`);
    } else {
      await ctx.editMessageText(`Could not approve: ${result.description}`);
    }
  } else {
    const result = await denyAction(actionId);
    if (result.success) {
      await ctx.editMessageText(`Denied: ${result.description}`);
    } else {
      await ctx.editMessageText(`Could not deny: ${result.description}`);
    }
  }

  await ctx.answerCallbackQuery();
});

// ============================================================
// HELPERS
// ============================================================

// Load profile once at startup
let profileContext = "";
try {
  profileContext = await readFile(join(PROJECT_ROOT, "config", "profile.md"), "utf-8");
} catch {
  // No profile yet — that's fine
}

const USER_NAME = process.env.USER_NAME || "";
const USER_TIMEZONE = process.env.USER_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone;

async function buildPrompt(userMessage: string, agent?: AgentConfig): Promise<string> {
  const now = new Date();
  const timeStr = now.toLocaleString("en-US", {
    timeZone: USER_TIMEZONE,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  const parts: string[] = [];

  // Use agent-specific system prompt if in forum mode, otherwise default
  if (agent) {
    parts.push(agent.systemPrompt);
    parts.push(`\nYou are responding via Telegram. Keep responses concise and conversational.`);
  } else {
    parts.push("You are a personal AI assistant responding via Telegram. Keep responses concise and conversational.");
  }

  if (USER_NAME) parts.push(`You are speaking with ${USER_NAME}.`);
  parts.push(`Current time: ${timeStr}`);
  if (profileContext) parts.push(`\nProfile:\n${profileContext}`);

  // Memory context (goals, facts, preferences)
  const memoryCtx = await getMemoryContext();
  if (memoryCtx) parts.push(`\n${memoryCtx}`);

  // Recent conversation history
  const recentMessages = await getRecentMessages(10);
  if (recentMessages) parts.push(`\nRecent conversation:\n${recentMessages}`);

  // Memory management instructions
  parts.push(`
MEMORY MANAGEMENT:
When the user mentions something to remember, goals, or completions,
include these tags in your response (they will be processed automatically):
[REMEMBER: fact to store]
[GOAL: goal text | DEADLINE: optional date]
[DONE: search text for completed goal]

ACTION REQUESTS:
When the user asks you to take an external action (send email, create task,
update calendar, etc.), include this tag in your response instead of doing it directly:
[ACTION: action_type | KEY: value | KEY: value]
The user will be shown an Approve/Deny button before execution.
Supported types and fields:
- [ACTION: send_email | TO: recipient | SUBJECT: subject | BODY: message]
- [ACTION: create_task | TITLE: task title | DUE: optional date]
- [ACTION: update_calendar | EVENT: event name | TIME: date/time]
- [ACTION: custom_type | KEY: value] for anything else`);

  parts.push(`\nUser: ${userMessage}`);

  return parts.join("\n");
}

/**
 * Send a long message to a specific chat/topic, splitting if needed.
 * Used by board meetings to post to agent-specific forum topics.
 */
async function sendLongMessage(
  api: Bot["api"],
  chatId: number | string,
  text: string,
  threadId?: number,
): Promise<void> {
  const MAX_LENGTH = 4000;
  const opts: Record<string, unknown> = {};
  if (threadId) opts.message_thread_id = threadId;

  if (text.length <= MAX_LENGTH) {
    await api.sendMessage(chatId, text, opts as any);
    return;
  }

  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= MAX_LENGTH) {
      await api.sendMessage(chatId, remaining, opts as any);
      break;
    }
    let splitIndex = remaining.lastIndexOf("\n\n", MAX_LENGTH);
    if (splitIndex === -1) splitIndex = remaining.lastIndexOf("\n", MAX_LENGTH);
    if (splitIndex === -1) splitIndex = remaining.lastIndexOf(" ", MAX_LENGTH);
    if (splitIndex === -1) splitIndex = MAX_LENGTH;

    await api.sendMessage(chatId, remaining.substring(0, splitIndex), opts as any);
    remaining = remaining.substring(splitIndex).trim();
  }
}

async function sendResponse(ctx: Context, response: string): Promise<void> {
  // Telegram has a 4096 character limit
  const MAX_LENGTH = 4000;

  if (response.length <= MAX_LENGTH) {
    await ctx.reply(response);
    return;
  }

  // Split long responses
  const chunks = [];
  let remaining = response;

  while (remaining.length > 0) {
    if (remaining.length <= MAX_LENGTH) {
      chunks.push(remaining);
      break;
    }

    // Try to split at a natural boundary
    let splitIndex = remaining.lastIndexOf("\n\n", MAX_LENGTH);
    if (splitIndex === -1) splitIndex = remaining.lastIndexOf("\n", MAX_LENGTH);
    if (splitIndex === -1) splitIndex = remaining.lastIndexOf(" ", MAX_LENGTH);
    if (splitIndex === -1) splitIndex = MAX_LENGTH;

    chunks.push(remaining.substring(0, splitIndex));
    remaining = remaining.substring(splitIndex).trim();
  }

  for (const chunk of chunks) {
    await ctx.reply(chunk);
  }
}

// ============================================================
// HEALTH CHECK ENDPOINT
// ============================================================

const HEALTH_PORT = parseInt(process.env.HEALTH_PORT || "3000");
const botStartTime = Date.now();

Bun.serve({
  port: HEALTH_PORT,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/health") {
      return new Response(
        JSON.stringify({
          status: "ok",
          uptime: Math.floor((Date.now() - botStartTime) / 1000),
          timestamp: new Date().toISOString(),
          sessionId: sessions.sessionId,
          lastProvider,
          fallbackEnabled: isFallbackEnabled(),
          forumMode: isForumMode(),
        }),
        { headers: { "Content-Type": "application/json" } }
      );
    }
    return new Response("Not found", { status: 404 });
  },
});

// ============================================================
// START
// ============================================================

// Initialize agents
await initAgents();

log("bot_starting", "Claude Telegram Relay starting", {
  metadata: {
    user: ALLOWED_USER_ID || "ANY",
    projectDir: PROJECT_DIR || "(relay working directory)",
    healthPort: HEALTH_PORT,
    ttsAvailable: isTTSAvailable(),
    forumMode: isForumMode(),
    forumGroupId: FORUM_GROUP_ID || undefined,
  },
});

bot.start({
  onStart: () => {
    log("bot_running", "Bot is running!");
  },
});
