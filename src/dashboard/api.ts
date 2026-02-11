/**
 * Dashboard API Module
 *
 * Handles all /api/dashboard/* endpoints.
 * Queries Supabase and returns JSON responses.
 * Includes Daily dashboard (data.json, weather, captures, tasks)
 * and Projects (Obsidian vault parser).
 */

import { getSupabase } from "../supabase";
import { getAllAgents, isForumMode } from "../agents/registry";
import { isTTSAvailable } from "../tts";
import { isPhoneAvailable } from "../phone";
import { isFallbackEnabled } from "../fallback";
import { getAllModelConfigs, setModelForAgent } from "../models/manager";
import { getAvailableModels } from "../analytics/token-tracker";
import { join } from "path";
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "fs";

// ── Daily/Projects Constants ────────────────────────────────
const DATA_DIR = join(import.meta.dir, "../../data");
const DATA_FILE = join(DATA_DIR, "data.json");
const CAPTURES_FILE = join(DATA_DIR, "captures.json");
const PROJECTS_DIR = process.env.OBSIDIAN_PROJECTS_DIR || "/home/clawdbot/obsidian-vault/Projects";

// Weather cache (30 minutes)
let weatherCache: { data: any; timestamp: number } = { data: null, timestamp: 0 };
const WEATHER_CACHE_MS = 30 * 60 * 1000;

// Projects cache (60 seconds)
let projectsCache: { data: any; timestamp: number } = { data: null, timestamp: 0 };
const PROJECTS_CACHE_MS = 60 * 1000;

// ── Stats ────────────────────────────────────────────────────

export async function getStats() {
  const sb = getSupabase();
  if (!sb) return { messagesToday: 0, activeGoals: 0, pendingActions: 0, errorsToday: 0 };

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayISO = todayStart.toISOString();

  const [messages, goals, actions, errors] = await Promise.all([
    sb.from("messages").select("id", { count: "exact", head: true }).gte("created_at", todayISO),
    sb.from("memory").select("id", { count: "exact", head: true }).eq("type", "goal"),
    sb.from("actions").select("id", { count: "exact", head: true }).eq("status", "pending"),
    sb.from("logs").select("id", { count: "exact", head: true }).eq("level", "error").gte("created_at", todayISO),
  ]);

  return {
    messagesToday: messages.count || 0,
    activeGoals: goals.count || 0,
    pendingActions: actions.count || 0,
    errorsToday: errors.count || 0,
  };
}

// ── Logs ─────────────────────────────────────────────────────

export async function getLogs(params: URLSearchParams) {
  const sb = getSupabase();
  if (!sb) return [];

  const level = params.get("level") || "";
  const search = params.get("search") || "";
  const limit = Math.min(parseInt(params.get("limit") || "100"), 500);

  let query = sb
    .from("logs")
    .select("id, created_at, level, event, message, metadata, duration_ms")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (level) query = query.eq("level", level);
  if (search) query = query.ilike("message", `%${search}%`);

  const { data } = await query;
  return data || [];
}

// ── Errors ───────────────────────────────────────────────────

export async function getErrors() {
  const sb = getSupabase();
  if (!sb) return { totalErrors: 0, errorRate: 0, recentErrors: [], topEvents: [] };

  const oneDayAgo = new Date(Date.now() - 86400_000).toISOString();
  const oneHourAgo = new Date(Date.now() - 3600_000).toISOString();

  const [dayErrors, hourErrors, recent] = await Promise.all([
    sb.from("logs").select("id", { count: "exact", head: true }).eq("level", "error").gte("created_at", oneDayAgo),
    sb.from("logs").select("id", { count: "exact", head: true }).eq("level", "error").gte("created_at", oneHourAgo),
    sb.from("logs")
      .select("id, created_at, event, message, metadata")
      .eq("level", "error")
      .order("created_at", { ascending: false })
      .limit(20),
  ]);

  // Get top error events
  const { data: allErrors } = await sb
    .from("logs")
    .select("event")
    .eq("level", "error")
    .gte("created_at", oneDayAgo);

  const eventCounts: Record<string, number> = {};
  for (const e of allErrors || []) {
    eventCounts[e.event] = (eventCounts[e.event] || 0) + 1;
  }
  const topEvents = Object.entries(eventCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([event, count]) => ({ event, count }));

  return {
    totalErrors: dayErrors.count || 0,
    errorRate: hourErrors.count || 0,
    recentErrors: recent.data || [],
    topEvents,
  };
}

// ── Messages ─────────────────────────────────────────────────

export async function getMessages(params: URLSearchParams) {
  const sb = getSupabase();
  if (!sb) return [];

  const agent = params.get("agent") || "";
  const limit = Math.min(parseInt(params.get("limit") || "50"), 200);

  let query = sb
    .from("messages")
    .select("id, created_at, role, content, agent, metadata")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (agent) query = query.eq("agent", agent);

  const { data } = await query;
  return data || [];
}

// ── Memory ───────────────────────────────────────────────────

export async function getMemory(params: URLSearchParams) {
  const sb = getSupabase();
  if (!sb) return { goals: [], facts: [], preferences: [], completed: [] };

  const type = params.get("type") || "";

  if (type) {
    const { data } = await sb
      .from("memory")
      .select("id, created_at, type, content, deadline, completed_at, priority")
      .eq("type", type)
      .order("created_at", { ascending: false })
      .limit(100);
    return data || [];
  }

  const [goals, facts, preferences, completed] = await Promise.all([
    sb.from("memory").select("*").eq("type", "goal").order("priority", { ascending: false }).order("created_at", { ascending: false }),
    sb.from("memory").select("*").eq("type", "fact").order("created_at", { ascending: false }).limit(50),
    sb.from("memory").select("*").eq("type", "preference").order("created_at", { ascending: false }).limit(50),
    sb.from("memory").select("*").eq("type", "completed_goal").order("completed_at", { ascending: false }).limit(20),
  ]);

  return {
    goals: goals.data || [],
    facts: facts.data || [],
    preferences: preferences.data || [],
    completed: completed.data || [],
  };
}

// ── Actions ──────────────────────────────────────────────────

export async function getActions(params: URLSearchParams) {
  const sb = getSupabase();
  if (!sb) return { pending: [], history: [], stats: { total: 0, approved: 0, denied: 0, executed: 0 } };

  const status = params.get("status") || "";

  if (status) {
    const { data } = await sb
      .from("actions")
      .select("*")
      .eq("status", status)
      .order("created_at", { ascending: false })
      .limit(50);
    return data || [];
  }

  const [pending, history, approved, denied, executed] = await Promise.all([
    sb.from("actions").select("*").eq("status", "pending").order("created_at", { ascending: false }),
    sb.from("actions").select("*").neq("status", "pending").order("created_at", { ascending: false }).limit(50),
    sb.from("actions").select("id", { count: "exact", head: true }).eq("status", "approved"),
    sb.from("actions").select("id", { count: "exact", head: true }).eq("status", "denied"),
    sb.from("actions").select("id", { count: "exact", head: true }).eq("status", "executed"),
  ]);

  return {
    pending: pending.data || [],
    history: history.data || [],
    stats: {
      total: (approved.count || 0) + (denied.count || 0) + (executed.count || 0),
      approved: approved.count || 0,
      denied: denied.count || 0,
      executed: executed.count || 0,
    },
  };
}

// ── Token Stats ──────────────────────────────────────────────

export async function getTokenStats(params: URLSearchParams) {
  const sb = getSupabase();
  if (!sb) return { total: { tokens: 0, cost: 0 }, byProvider: {}, byAgent: {}, byModel: {} };

  const range = params.get("range") || "24h";
  const hours = range === "7d" ? 168 : range === "30d" ? 720 : 24;
  const since = new Date(Date.now() - hours * 3600_000).toISOString();

  const { data } = await sb
    .from("token_usage")
    .select("provider, model, agent, total_tokens, cost_usd")
    .gte("created_at", since);

  const rows = data || [];

  let totalTokens = 0;
  let totalCost = 0;
  const byProvider: Record<string, { tokens: number; cost: number }> = {};
  const byAgent: Record<string, { tokens: number; cost: number }> = {};
  const byModel: Record<string, { tokens: number; cost: number }> = {};

  for (const row of rows) {
    const tokens = row.total_tokens || 0;
    const cost = parseFloat(row.cost_usd) || 0;

    totalTokens += tokens;
    totalCost += cost;

    if (!byProvider[row.provider]) byProvider[row.provider] = { tokens: 0, cost: 0 };
    byProvider[row.provider].tokens += tokens;
    byProvider[row.provider].cost += cost;

    if (!byAgent[row.agent]) byAgent[row.agent] = { tokens: 0, cost: 0 };
    byAgent[row.agent].tokens += tokens;
    byAgent[row.agent].cost += cost;

    if (!byModel[row.model]) byModel[row.model] = { tokens: 0, cost: 0 };
    byModel[row.model].tokens += tokens;
    byModel[row.model].cost += cost;
  }

  return {
    total: { tokens: totalTokens, cost: Math.round(totalCost * 1000000) / 1000000 },
    byProvider,
    byAgent,
    byModel,
  };
}

// ── Cost Timeline ────────────────────────────────────────────

export async function getCostTimeline(params: URLSearchParams) {
  const sb = getSupabase();
  if (!sb) return [];

  const period = params.get("period") || "day";
  const days = period === "month" ? 365 : period === "week" ? 90 : 30;
  const since = new Date(Date.now() - days * 86400_000).toISOString();

  const { data } = await sb
    .from("token_usage")
    .select("created_at, total_tokens, cost_usd")
    .gte("created_at", since)
    .order("created_at", { ascending: true });

  const rows = data || [];
  const buckets: Record<string, { tokens: number; cost: number }> = {};

  for (const row of rows) {
    const date = new Date(row.created_at);
    let key: string;

    if (period === "month") {
      key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
    } else if (period === "week") {
      // Group by ISO week start (Monday)
      const d = new Date(date);
      d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
      key = d.toISOString().split("T")[0];
    } else {
      key = date.toISOString().split("T")[0];
    }

    if (!buckets[key]) buckets[key] = { tokens: 0, cost: 0 };
    buckets[key].tokens += row.total_tokens || 0;
    buckets[key].cost += parseFloat(row.cost_usd) || 0;
  }

  return Object.entries(buckets).map(([date, data]) => ({
    date,
    tokens: data.tokens,
    cost: Math.round(data.cost * 1000000) / 1000000,
  }));
}

// ── Models ───────────────────────────────────────────────────

export async function getModels() {
  const configs = await getAllModelConfigs();
  const available = getAvailableModels();
  return { configs, available };
}

export async function updateModel(body: { agent: string; provider: string; model: string }) {
  if (!body.agent || !body.provider || !body.model) {
    throw new Error("Missing agent, provider, or model");
  }
  await setModelForAgent(body.agent, body.provider as any, body.model);
  return { success: true };
}

// ── Services ─────────────────────────────────────────────────

export function getServices() {
  const agents = getAllAgents();

  return {
    bot: {
      forumMode: isForumMode(),
      tts: isTTSAvailable(),
      phone: isPhoneAvailable(),
      fallback: isFallbackEnabled(),
    },
    integrations: {
      supabase: !!(process.env.SUPABASE_URL && !process.env.SUPABASE_URL.includes("your_")),
      weather: !!process.env.OPENWEATHERMAP_API_KEY,
      notion: !!(process.env.NOTION_API_KEY && process.env.NOTION_DATABASE_ID),
      gmail: true, // MCP-based, always "available"
      calendar: true,
    },
    agents: agents.map((a) => ({
      name: a.name,
      slug: a.slug,
      topicId: a.topicId || null,
    })),
  };
}

// ══════════════════════════════════════════════════════════════
// ── Daily Dashboard ─────────────────────────────────────────
// ══════════════════════════════════════════════════════════════

function readJSON(file: string): any {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return file === CAPTURES_FILE ? [] : {};
  }
}

function writeJSON(file: string, data: any): void {
  writeFileSync(file, JSON.stringify(data, null, 2));
}

export function getDaily() {
  return readJSON(DATA_FILE);
}

const WMO_CONDITIONS: Record<number, string> = {
  0: "Clear sky", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
  45: "Fog", 48: "Rime fog",
  51: "Light drizzle", 53: "Moderate drizzle", 55: "Dense drizzle",
  61: "Slight rain", 63: "Moderate rain", 65: "Heavy rain",
  71: "Slight snow", 73: "Moderate snow", 75: "Heavy snow",
  80: "Slight showers", 81: "Moderate showers", 82: "Violent showers",
  95: "Thunderstorm", 96: "Thunderstorm w/ hail", 99: "Thunderstorm w/ heavy hail",
};

const WMO_TO_ICON: Record<number, string> = {
  0: "113", 1: "113", 2: "116", 3: "122",
  45: "143", 48: "143",
  51: "176", 53: "176", 55: "296",
  61: "296", 63: "302", 65: "308",
  71: "179", 73: "329", 75: "338",
  80: "176", 81: "302", 82: "308",
  95: "200", 96: "200", 99: "200",
};

export async function getWeather() {
  const now = Date.now();
  if (weatherCache.data && (now - weatherCache.timestamp) < WEATHER_CACHE_MS) {
    return weatherCache.data;
  }
  try {
    const apiUrl = "https://api.open-meteo.com/v1/forecast?latitude=39.40&longitude=-76.60&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m,wind_direction_10m&temperature_unit=fahrenheit&wind_speed_unit=mph";
    const res = await fetch(apiUrl);
    const weatherRes = await res.json();
    const cur = weatherRes.current || {};
    const tempF = Math.round(cur.temperature_2m || 0);
    const tempC = Math.round((tempF - 32) * 5 / 9);
    const dirs = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
    const windDeg = cur.wind_direction_10m || 0;
    const windDir = dirs[Math.round(windDeg / 22.5) % 16];
    const code = cur.weather_code ?? 0;
    const weather = {
      temp_F: String(tempF),
      temp_C: String(tempC),
      condition: WMO_CONDITIONS[code] || "Unknown",
      humidity: String(cur.relative_humidity_2m || "--"),
      windMph: String(Math.round(cur.wind_speed_10m || 0)),
      windDir,
      icon: WMO_TO_ICON[code] || "116",
    };
    weatherCache = { data: weather, timestamp: now };
    return weather;
  } catch {
    if (weatherCache.data) return weatherCache.data;
    return { error: "Weather unavailable" };
  }
}

export function getCaptures() {
  return readJSON(CAPTURES_FILE);
}

export function addCapture(body: { text: string }) {
  const captures = readJSON(CAPTURES_FILE);
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  captures.push({ text: body.text, timestamp: new Date().toISOString(), id });
  writeJSON(CAPTURES_FILE, captures);
  return { ok: true, id };
}

export function deleteCapture(body: { id: string }) {
  let captures = readJSON(CAPTURES_FILE);
  captures = captures.filter((c: any) => c.id !== body.id);
  writeJSON(CAPTURES_FILE, captures);
  return { ok: true };
}

export function moveCapture(body: { id: string; column: string }) {
  const validCols = ["today", "thisWeek", "nextWeek", "later", "noDate"];
  if (!validCols.includes(body.column)) throw new Error("Invalid column");
  let captures = readJSON(CAPTURES_FILE);
  const capture = captures.find((c: any) => c.id === body.id);
  if (!capture) throw new Error("Capture not found");
  captures = captures.filter((c: any) => c.id !== body.id);
  writeJSON(CAPTURES_FILE, captures);
  const data = readJSON(DATA_FILE);
  if (!data.tasks) data.tasks = {};
  if (!data.tasks[body.column]) data.tasks[body.column] = [];
  data.tasks[body.column].push(capture.text);
  writeJSON(DATA_FILE, data);
  return { ok: true };
}

export function taskDone(body: { column: string; index: number }) {
  const data = readJSON(DATA_FILE);
  if (!data.tasks?.[body.column]?.[body.index]) throw new Error("Task not found");
  const task = data.tasks[body.column].splice(body.index, 1)[0];
  if (!data.tasks.done) data.tasks.done = [];
  data.tasks.done.push({ text: task, completedAt: new Date().toISOString(), from: body.column });
  writeJSON(DATA_FILE, data);
  return { ok: true, task };
}

export function taskMove(body: { fromColumn: string; index: number; toColumn: string }) {
  const validCols = ["today", "thisWeek", "nextWeek", "later", "noDate"];
  if (!validCols.includes(body.fromColumn) || !validCols.includes(body.toColumn)) throw new Error("Invalid column");
  const data = readJSON(DATA_FILE);
  if (!data.tasks?.[body.fromColumn]?.[body.index]) throw new Error("Task not found");
  const task = data.tasks[body.fromColumn].splice(body.index, 1)[0];
  if (!data.tasks[body.toColumn]) data.tasks[body.toColumn] = [];
  data.tasks[body.toColumn].push(task);
  writeJSON(DATA_FILE, data);
  return { ok: true };
}

export function taskTrash(body: { column: string; index: number }) {
  const data = readJSON(DATA_FILE);
  if (!data.tasks?.[body.column]?.[body.index]) throw new Error("Task not found");
  const task = data.tasks[body.column].splice(body.index, 1)[0];
  if (!data.tasks.trash) data.tasks.trash = [];
  data.tasks.trash.push({ text: task, trashedAt: new Date().toISOString(), from: body.column });
  writeJSON(DATA_FILE, data);
  return { ok: true, task };
}

export function taskRestore(body: { index: number; toColumn?: string }) {
  const validCols = ["today", "thisWeek", "nextWeek", "later", "noDate"];
  const col = body.toColumn && validCols.includes(body.toColumn) ? body.toColumn : "today";
  const data = readJSON(DATA_FILE);
  if (!data.tasks?.trash?.[body.index]) throw new Error("Trash item not found");
  const item = data.tasks.trash.splice(body.index, 1)[0];
  if (!data.tasks[col]) data.tasks[col] = [];
  data.tasks[col].push(item.text);
  writeJSON(DATA_FILE, data);
  return { ok: true };
}

// ══════════════════════════════════════════════════════════════
// ── Projects (Obsidian Vault Parser) ────────────────────────
// ══════════════════════════════════════════════════════════════

function parseFrontmatter(content: string): { frontmatter: Record<string, any>; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return { frontmatter: {}, body: content };
  const raw = match[1];
  const body = content.slice(match[0].length).trim();
  const frontmatter: Record<string, any> = {};
  for (const line of raw.split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let val: any = line.slice(idx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    val = val.replace(/\[\[([^\]|]+)(\|[^\]]+)?\]\]/g, "$1");
    if (val === "" || val === "null") val = null;
    frontmatter[key] = val;
  }
  return { frontmatter, body };
}

function parseCheckboxes(body: string) {
  const lines = body.split("\n");
  const sections: { name: string; todos: { text: string; done: boolean }[] }[] = [];
  let currentSection: { name: string; todos: { text: string; done: boolean }[] } | null = null;
  const topLevelTodos: { text: string; done: boolean }[] = [];
  for (const line of lines) {
    const headingMatch = line.match(/^##\s+(.+)/);
    if (headingMatch) {
      currentSection = { name: headingMatch[1].trim(), todos: [] };
      sections.push(currentSection);
      continue;
    }
    const checkMatch = line.match(/^[-*]\s+\[([ xX])\]\s+(.+)/);
    if (checkMatch) {
      const todo = { text: checkMatch[2].replace(/\*\*/g, "").trim(), done: checkMatch[1].toLowerCase() === "x" };
      if (currentSection) currentSection.todos.push(todo);
      else topLevelTodos.push(todo);
    }
  }
  return { topLevelTodos, sections };
}

function categoryEmoji(category: string | null, name: string): string {
  const nameLower = (name || "").toLowerCase();
  if (nameLower.includes("artemis")) return "\u{1F680}";
  if (nameLower.includes("eclipse")) return "\u{1F311}";
  if (nameLower.includes("sun today") || nameLower.includes("solar")) return "\u2600\uFE0F";
  if (nameLower.includes("finland") || nameLower.includes("trip")) return "\u2708\uFE0F";
  if (nameLower.includes("adhd")) return "\u{1F9E0}";
  if (nameLower.includes("elder care")) return "\u{1F495}";
  if (nameLower.includes("home")) return "\u{1F3E0}";
  if (nameLower.includes("miscellaneous")) return "\u{1F4CC}";
  if (nameLower.includes("newsletter")) return "\u{1F4F0}";
  if (nameLower.includes("website") || nameLower.includes("web")) return "\u{1F310}";
  if (nameLower.includes("dashboard") || nameLower.includes("data")) return "\u{1F4CA}";
  if (nameLower.includes("learning") || nameLower.includes("ml-ai")) return "\u{1F4DA}";
  if (nameLower.includes("outreach") || nameLower.includes("communication")) return "\u{1F4E1}";
  if (nameLower.includes("brand") || nameLower.includes("toolkit")) return "\u{1F3A8}";
  if (nameLower.includes("innovation") || nameLower.includes("space")) return "\u{1F4A1}";
  if (nameLower.includes("mission")) return "\u{1F6F0}\uFE0F";
  if (nameLower.includes("report")) return "\u{1F4DD}";
  const catMap: Record<string, string> = { nasa: "\u{1F6F0}\uFE0F", personal: "\u{1F3E1}", earthsky: "\u{1F30D}", smithsonian: "\u{1F3DB}\uFE0F", learning: "\u{1F4DA}" };
  return catMap[category || ""] || "\u{1F4CB}";
}

function parseProjectFile(filePath: string) {
  const content = readFileSync(filePath, "utf8");
  const stat = statSync(filePath);
  const { frontmatter, body } = parseFrontmatter(content);
  const { topLevelTodos, sections } = parseCheckboxes(body);
  const fileName = filePath.split("/").pop()!.replace(/\.md$/, "");
  const id = fileName.replace(/\s+/g, "-").toLowerCase();
  const titleMatch = body.match(/^#\s+(.+)/m);
  const name = titleMatch ? titleMatch[1].trim() : fileName;
  const emojiMatch = name.match(/^(\p{Emoji_Presentation}|\p{Emoji}\uFE0F)/u);
  const emoji = emojiMatch ? emojiMatch[0] : categoryEmoji(frontmatter.category, name);
  const allTodos = [...topLevelTodos];
  for (const sec of sections) allTodos.push(...sec.todos);
  const doneCount = allTodos.filter((t) => t.done).length;
  const totalCount = allTodos.length;
  const percent = totalCount > 0 ? Math.round((doneCount / totalCount) * 100) : 0;
  const nextTodo = allTodos.find((t) => !t.done);
  const staleDays = Math.floor((Date.now() - stat.mtimeMs) / (1000 * 60 * 60 * 24));
  return {
    id, fileName, emoji,
    name: name.replace(/^\p{Emoji_Presentation}\s*/u, "").replace(/^\p{Emoji}\uFE0F\s*/u, ""),
    status: frontmatter.status || "active",
    priority: frontmatter.priority || "normal",
    category: frontmatter.category || "uncategorized",
    deadline: frontmatter.deadline || null,
    client: frontmatter.client || null,
    progress: { done: doneCount, total: totalCount, percent },
    nextAction: nextTodo ? nextTodo.text : null,
    staleDays, isStale: staleDays >= 7,
    modifiedAt: stat.mtime.toISOString(),
  };
}

function parseProjectDetail(filePath: string) {
  const summary = parseProjectFile(filePath);
  const content = readFileSync(filePath, "utf8");
  const { body } = parseFrontmatter(content);
  const { topLevelTodos, sections } = parseCheckboxes(body);
  return {
    ...summary,
    sections: sections.map((s) => ({ name: s.name, todos: s.todos, done: s.todos.filter((t) => t.done).length, total: s.todos.length })),
    topLevelTodos,
    body,
  };
}

export function getAllProjects() {
  const now = Date.now();
  if (projectsCache.data && (now - projectsCache.timestamp) < PROJECTS_CACHE_MS) return projectsCache.data;
  try {
    if (!existsSync(PROJECTS_DIR)) return [];
    const files = readdirSync(PROJECTS_DIR).filter((f) => f.endsWith(".md"));
    const projects = files.map((f) => {
      try { return parseProjectFile(join(PROJECTS_DIR, f)); }
      catch { return null; }
    }).filter(Boolean);
    const priorityOrder: Record<string, number> = { high: 0, medium: 1, normal: 2, low: 3 };
    projects.sort((a: any, b: any) => {
      const pa = priorityOrder[a.priority] ?? 2;
      const pb = priorityOrder[b.priority] ?? 2;
      if (pa !== pb) return pa - pb;
      if (b.isStale !== a.isStale) return b.isStale ? 1 : -1;
      return a.name.localeCompare(b.name);
    });
    projectsCache = { data: projects, timestamp: now };
    return projects;
  } catch {
    return [];
  }
}

export function getProjectDetail(requestedId: string) {
  if (!existsSync(PROJECTS_DIR)) throw new Error("Projects directory not found");
  const files = readdirSync(PROJECTS_DIR).filter((f) => f.endsWith(".md"));
  const matchFile = files.find((f) => {
    const slug = f.replace(/\.md$/, "").replace(/\s+/g, "-").toLowerCase();
    return slug === requestedId;
  });
  if (!matchFile) throw new Error("Project not found");
  return parseProjectDetail(join(PROJECTS_DIR, matchFile));
}
