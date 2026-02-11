/**
 * Dashboard API Module
 *
 * Handles all /api/dashboard/* endpoints.
 * Queries Supabase and returns JSON responses.
 */

import { getSupabase } from "../supabase";
import { getAllAgents, isForumMode } from "../agents/registry";
import { isTTSAvailable } from "../tts";
import { isPhoneAvailable } from "../phone";
import { isFallbackEnabled } from "../fallback";
import { getAllModelConfigs, setModelForAgent } from "../models/manager";
import { getAvailableModels } from "../analytics/token-tracker";

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
