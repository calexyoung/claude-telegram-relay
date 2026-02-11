/**
 * Calendar Integration — via Claude CLI with MCP
 *
 * Fetches today's calendar events by asking Claude (with Google Calendar MCP)
 * to read the schedule. Falls back gracefully if MCP isn't configured.
 *
 * Setup:
 * 1. claude mcp add gcal -- npx -y @anthropic/gcal-mcp
 * 2. Authenticate when prompted (OAuth flow opens in browser)
 */

import { spawn } from "bun";

const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";

export interface CalendarEvent {
  time: string;
  title: string;
  location: string | null;
  attendees: string[];
}

/**
 * Check if Calendar MCP is likely available.
 */
export function isCalendarAvailable(): boolean {
  return true;
}

/**
 * Fetch today's calendar events via Claude CLI + Google Calendar MCP.
 * Returns parsed events, or an empty array on failure.
 */
export async function getTodayEvents(): Promise<CalendarEvent[]> {
  try {
    const today = new Date().toISOString().split("T")[0];

    const prompt = `Using the Google Calendar tool, get my events for today (${today}).

For each event, output EXACTLY this format (one per event):
TIME: <start time in HH:MM format>
TITLE: <event title>
LOCATION: <location or "none">
ATTENDEES: <comma-separated names, or "none">
---

If there are no events today, respond with: NO_EVENTS
If you cannot access Google Calendar (MCP not configured), respond with: CALENDAR_UNAVAILABLE`;

    const proc = spawn([CLAUDE_PATH, "-p", prompt, "--output-format", "text"], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: 30_000,
    });

    const output = await new Response(proc.stdout).text();

    if (output.includes("NO_EVENTS")) return [];
    if (output.includes("CALENDAR_UNAVAILABLE")) return [];

    return parseCalendarOutput(output);
  } catch {
    return [];
  }
}

/**
 * Parse Claude's structured calendar output into CalendarEvent objects.
 */
function parseCalendarOutput(output: string): CalendarEvent[] {
  const events: CalendarEvent[] = [];
  const blocks = output.split("---").filter((b) => b.trim());

  for (const block of blocks) {
    const time = block.match(/TIME:\s*(.+)/i)?.[1]?.trim();
    const title = block.match(/TITLE:\s*(.+)/i)?.[1]?.trim();
    const location = block.match(/LOCATION:\s*(.+)/i)?.[1]?.trim();
    const attendeesStr = block.match(/ATTENDEES:\s*(.+)/i)?.[1]?.trim();

    if (time && title) {
      events.push({
        time,
        title,
        location: location === "none" ? null : (location || null),
        attendees:
          attendeesStr && attendeesStr !== "none"
            ? attendeesStr.split(",").map((a) => a.trim())
            : [],
      });
    }
  }

  // Sort by time
  events.sort((a, b) => a.time.localeCompare(b.time));

  return events;
}

/**
 * Format calendar events as a human-readable string.
 */
export function formatEvents(events: CalendarEvent[]): string {
  if (events.length === 0) return "No events today";

  return events
    .map((e) => {
      const loc = e.location ? ` @ ${e.location}` : "";
      const attendees = e.attendees.length > 0 ? ` (with ${e.attendees.join(", ")})` : "";
      return `- ${e.time} ${e.title}${loc}${attendees}`;
    })
    .join("\n");
}
