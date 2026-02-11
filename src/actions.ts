/**
 * Human-in-the-Loop Action Queue
 *
 * When Claude suggests an external action (send email, create task, etc.),
 * the bot presents inline buttons for the user to approve or deny.
 * Actions are stored in Supabase and only executed after approval.
 */

import { getSupabase } from "./supabase";
import { log, logError } from "./logger";

// ============================================================
// TYPES
// ============================================================

export interface ParsedAction {
  type: string;
  fields: Record<string, string>;
}

export interface PendingAction {
  id: string;
  type: string;
  description: string;
  payload: Record<string, unknown>;
  status: "pending" | "approved" | "denied" | "executed";
  created_at: string;
  executed_at: string | null;
}

// ============================================================
// EXTRACT ACTIONS FROM CLAUDE'S RESPONSE
// ============================================================

/**
 * Parses [ACTION: type | KEY: value | KEY: value] tags from Claude's response.
 * Returns the cleaned text (tags removed) and an array of parsed actions.
 */
export function extractActions(response: string): {
  cleaned: string;
  actions: ParsedAction[];
} {
  const actions: ParsedAction[] = [];
  let cleaned = response;

  const actionRegex = /\[ACTION:\s*([^\]|]+?)(?:\s*\|(.+?))?\]/gi;
  const matches = [...response.matchAll(actionRegex)];

  for (const match of matches) {
    const type = match[1].trim().toLowerCase();
    const fields: Record<string, string> = {};

    // Parse key-value pairs after the type
    if (match[2]) {
      const pairs = match[2].split("|");
      for (const pair of pairs) {
        const colonIdx = pair.indexOf(":");
        if (colonIdx !== -1) {
          const key = pair.slice(0, colonIdx).trim().toLowerCase();
          const value = pair.slice(colonIdx + 1).trim();
          fields[key] = value;
        }
      }
    }

    actions.push({ type, fields });
    cleaned = cleaned.replace(match[0], "");
  }

  return { cleaned: cleaned.trim(), actions };
}

// ============================================================
// ACTION QUEUE
// ============================================================

/**
 * Stores an action in Supabase and returns its ID.
 * Returns null if Supabase is unavailable.
 */
export async function queueAction(action: ParsedAction): Promise<string | null> {
  const sb = getSupabase();
  if (!sb) return null;

  const description = formatActionDescription(action);

  const { data, error } = await sb
    .from("actions")
    .insert({
      type: action.type,
      description,
      payload: action.fields,
      status: "pending",
    })
    .select("id")
    .single();

  if (error || !data) {
    logError("action_queue_error", "Failed to queue action", error);
    return null;
  }

  log("action_queued", description, { metadata: { actionId: data.id, type: action.type } });
  return data.id;
}

/**
 * Marks an action as approved and executes it.
 */
export async function approveAction(actionId: string): Promise<{
  success: boolean;
  description: string;
}> {
  const sb = getSupabase();
  if (!sb) return { success: false, description: "Database unavailable" };

  const action = await getAction(actionId);
  if (!action) return { success: false, description: "Action not found" };
  if (action.status !== "pending") {
    return { success: false, description: `Action already ${action.status}` };
  }

  // Mark as approved
  const { error: updateError } = await sb
    .from("actions")
    .update({ status: "approved" })
    .eq("id", actionId);

  if (updateError) {
    logError("action_approve_error", "Failed to approve action", updateError);
    return { success: false, description: "Failed to approve" };
  }

  // Execute the action
  const result = await executeAction(action);

  // Mark as executed
  await sb
    .from("actions")
    .update({
      status: "executed",
      executed_at: new Date().toISOString(),
    })
    .eq("id", actionId);

  log("action_executed", action.description, {
    metadata: { actionId, type: action.type },
  });

  return { success: true, description: result };
}

/**
 * Marks an action as denied.
 */
export async function denyAction(actionId: string): Promise<{
  success: boolean;
  description: string;
}> {
  const sb = getSupabase();
  if (!sb) return { success: false, description: "Database unavailable" };

  const action = await getAction(actionId);
  if (!action) return { success: false, description: "Action not found" };
  if (action.status !== "pending") {
    return { success: false, description: `Action already ${action.status}` };
  }

  const { error } = await sb
    .from("actions")
    .update({ status: "denied" })
    .eq("id", actionId);

  if (error) {
    logError("action_deny_error", "Failed to deny action", error);
    return { success: false, description: "Failed to deny" };
  }

  log("action_denied", action.description, {
    metadata: { actionId, type: action.type },
  });

  return { success: true, description: action.description };
}

// ============================================================
// HELPERS
// ============================================================

async function getAction(actionId: string): Promise<PendingAction | null> {
  const sb = getSupabase();
  if (!sb) return null;

  const { data, error } = await sb
    .from("actions")
    .select("*")
    .eq("id", actionId)
    .single();

  if (error || !data) return null;
  return data as PendingAction;
}

/**
 * Execute an approved action.
 * Currently returns a confirmation message — real integrations
 * (Gmail, Calendar, Notion) will be wired in Feature 3.
 */
async function executeAction(action: PendingAction): Promise<string> {
  const payload = action.payload as Record<string, string>;

  switch (action.type) {
    case "send_email":
      log("action_execute", `Would send email to ${payload.to}`, {
        metadata: { type: "send_email", to: payload.to, subject: payload.subject },
      });
      return `Email action logged: to ${payload.to}, subject "${payload.subject}". (Integration pending — connect Gmail in Feature 3)`;

    case "create_task":
      log("action_execute", `Would create task: ${payload.title}`, {
        metadata: { type: "create_task", title: payload.title },
      });
      return `Task action logged: "${payload.title}". (Integration pending — connect Notion in Feature 3)`;

    case "update_calendar":
      log("action_execute", `Would update calendar: ${payload.event}`, {
        metadata: { type: "update_calendar", event: payload.event },
      });
      return `Calendar action logged: "${payload.event}". (Integration pending — connect Google Calendar in Feature 3)`;

    default:
      log("action_execute", `Custom action: ${action.description}`, {
        metadata: { type: action.type, payload },
      });
      return `Action "${action.type}" logged. (No handler configured yet)`;
  }
}

/**
 * Build a human-readable description of an action.
 */
function formatActionDescription(action: ParsedAction): string {
  const f = action.fields;

  switch (action.type) {
    case "send_email":
      return `Send email to ${f.to || "?"}${f.subject ? `: "${f.subject}"` : ""}`;
    case "create_task":
      return `Create task: "${f.title || "?"}"${f.due ? ` (due ${f.due})` : ""}`;
    case "update_calendar":
      return `Update calendar: "${f.event || "?"}"${f.time ? ` at ${f.time}` : ""}`;
    default:
      return `${action.type}: ${Object.entries(f).map(([k, v]) => `${k}=${v}`).join(", ")}`;
  }
}
