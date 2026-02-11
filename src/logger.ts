/**
 * Structured Logger
 *
 * Writes JSON to console and fire-and-forget to the Supabase logs table.
 * Matches schema: level, event, message, metadata, session_id, duration_ms
 */

import { getSupabase } from "./supabase";

type LogLevel = "debug" | "info" | "warn" | "error";

interface LogOptions {
  level?: LogLevel;
  metadata?: Record<string, unknown>;
  sessionId?: string;
  durationMs?: number;
}

export function log(event: string, message: string, opts: LogOptions = {}): void {
  const level = opts.level || "info";
  const entry: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    level,
    event,
    message,
  };

  if (opts.metadata) entry.metadata = opts.metadata;
  if (opts.sessionId) entry.session_id = opts.sessionId;
  if (opts.durationMs !== undefined) entry.duration_ms = opts.durationMs;

  // Console output
  if (level === "error") {
    console.error(JSON.stringify(entry));
  } else if (level === "warn") {
    console.warn(JSON.stringify(entry));
  } else {
    console.log(JSON.stringify(entry));
  }

  // Fire-and-forget to Supabase
  const sb = getSupabase();
  if (sb) {
    sb.from("logs")
      .insert({
        level,
        event,
        message,
        metadata: opts.metadata || {},
        session_id: opts.sessionId,
        duration_ms: opts.durationMs,
      })
      .then(() => {})
      .catch(() => {});
  }
}

export function logError(event: string, message: string, error?: unknown): void {
  log(event, message, {
    level: "error",
    metadata: error instanceof Error
      ? { error: error.message, stack: error.stack }
      : error
        ? { error: String(error) }
        : undefined,
  });
}
