/**
 * Memory Persistence Module
 *
 * Saves conversations and manages facts/goals via Supabase.
 * All functions degrade gracefully when Supabase is unavailable.
 */

import { getSupabase } from "./supabase";
import { log, logError } from "./logger";

// ============================================================
// CONVERSATION STORAGE
// ============================================================

export async function saveMessage(
  role: "user" | "assistant",
  content: string,
  metadata?: Record<string, unknown>
): Promise<void> {
  const sb = getSupabase();
  if (!sb) return;

  const { error } = await sb.from("messages").insert({
    role,
    content,
    channel: "telegram",
    metadata: metadata || {},
  });

  if (error) {
    logError("memory_save_error", `Failed to save ${role} message`, error);
  }
}

export async function getRecentMessages(limit = 10): Promise<string> {
  const sb = getSupabase();
  if (!sb) return "";

  const { data, error } = await sb
    .from("messages")
    .select("role, content, created_at")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error || !data || data.length === 0) return "";

  // Reverse to chronological order and format
  return data
    .reverse()
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
    .join("\n");
}

// ============================================================
// FACTS & GOALS
// ============================================================

export async function saveFact(content: string): Promise<void> {
  const sb = getSupabase();
  if (!sb) return;

  const { error } = await sb.from("memory").insert({ type: "fact", content });
  if (error) {
    logError("memory_fact_error", "Failed to save fact", error);
  } else {
    log("memory_fact_saved", content);
  }
}

export async function saveGoal(content: string, deadline?: string): Promise<void> {
  const sb = getSupabase();
  if (!sb) return;

  const row: Record<string, unknown> = { type: "goal", content };
  if (deadline) row.deadline = deadline;

  const { error } = await sb.from("memory").insert(row);
  if (error) {
    logError("memory_goal_error", "Failed to save goal", error);
  } else {
    log("memory_goal_saved", content);
  }
}

export async function completeGoal(searchText: string): Promise<void> {
  const sb = getSupabase();
  if (!sb) return;

  // Find matching goal
  const { data } = await sb
    .from("memory")
    .select("id, content")
    .eq("type", "goal")
    .ilike("content", `%${searchText}%`)
    .limit(1);

  if (!data || data.length === 0) return;

  const { error } = await sb
    .from("memory")
    .update({
      type: "completed_goal",
      completed_at: new Date().toISOString(),
    })
    .eq("id", data[0].id);

  if (error) {
    logError("memory_complete_error", "Failed to complete goal", error);
  } else {
    log("memory_goal_completed", data[0].content);
  }
}

// ============================================================
// MEMORY CONTEXT (for prompt injection)
// ============================================================

export async function getMemoryContext(): Promise<string> {
  const sb = getSupabase();
  if (!sb) return "";

  const parts: string[] = [];

  // Get active goals
  const { data: goals } = await sb
    .from("memory")
    .select("content, deadline, priority")
    .eq("type", "goal")
    .order("priority", { ascending: false })
    .order("created_at", { ascending: false });

  if (goals && goals.length > 0) {
    parts.push("ACTIVE GOALS:");
    for (const g of goals) {
      const deadline = g.deadline ? ` (by ${new Date(g.deadline).toLocaleDateString()})` : "";
      parts.push(`- ${g.content}${deadline}`);
    }
  }

  // Get facts
  const { data: facts } = await sb
    .from("memory")
    .select("content")
    .eq("type", "fact")
    .order("created_at", { ascending: false })
    .limit(20);

  if (facts && facts.length > 0) {
    parts.push("\nPERSISTENT MEMORY:");
    for (const f of facts) {
      parts.push(`- ${f.content}`);
    }
  }

  // Get preferences
  const { data: prefs } = await sb
    .from("memory")
    .select("content")
    .eq("type", "preference")
    .order("created_at", { ascending: false })
    .limit(10);

  if (prefs && prefs.length > 0) {
    parts.push("\nPREFERENCES:");
    for (const p of prefs) {
      parts.push(`- ${p.content}`);
    }
  }

  return parts.join("\n");
}

// ============================================================
// INTENT DETECTION (parse Claude's response for memory tags)
// ============================================================

export async function processIntents(response: string): Promise<string> {
  let clean = response;

  // [REMEMBER: fact to store]
  const rememberMatches = response.matchAll(/\[REMEMBER:\s*(.+?)\]/gi);
  for (const match of rememberMatches) {
    await saveFact(match[1].trim());
    clean = clean.replace(match[0], "");
  }

  // [GOAL: goal text | DEADLINE: optional date]
  const goalMatches = response.matchAll(/\[GOAL:\s*(.+?)(?:\s*\|\s*DEADLINE:\s*(.+?))?\]/gi);
  for (const match of goalMatches) {
    await saveGoal(match[1].trim(), match[2]?.trim());
    clean = clean.replace(match[0], "");
  }

  // [DONE: search text for completed goal]
  const doneMatches = response.matchAll(/\[DONE:\s*(.+?)\]/gi);
  for (const match of doneMatches) {
    await completeGoal(match[1].trim());
    clean = clean.replace(match[0], "");
  }

  return clean.trim();
}
