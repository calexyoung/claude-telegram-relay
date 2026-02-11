/**
 * Integrations — Unified Export
 *
 * Central hub for all external data sources.
 * Each integration degrades gracefully — if it's not configured
 * or fails, it returns empty/default data without breaking the whole system.
 */

export { getWeather, formatWeather, isWeatherAvailable } from "./weather";
export type { WeatherData } from "./weather";

export { getActiveTasks, formatTasks, isNotionAvailable } from "./notion";
export type { NotionTask } from "./notion";

export { getUnreadEmails, formatEmails, isGmailAvailable } from "./gmail";
export type { EmailSummary } from "./gmail";

export { getTodayEvents, formatEvents, isCalendarAvailable } from "./calendar";
export type { CalendarEvent } from "./calendar";

// ── Unified context gatherer ─────────────────────────────────

import { getWeather, formatWeather, isWeatherAvailable } from "./weather";
import { getActiveTasks, formatTasks, isNotionAvailable } from "./notion";
import { getUnreadEmails, formatEmails } from "./gmail";
import { getTodayEvents, formatEvents } from "./calendar";

export interface IntegrationContext {
  weather: string | null;
  calendar: string | null;
  emails: string | null;
  tasks: string | null;
}

/**
 * Gather context from all available integrations in parallel.
 * Each source is independent — one failing won't block others.
 */
export async function gatherAllContext(): Promise<IntegrationContext> {
  const [weather, calendar, emails, tasks] = await Promise.allSettled([
    // Weather — direct API, fast
    isWeatherAvailable()
      ? getWeather().then((d) => (d ? formatWeather(d) : null))
      : Promise.resolve(null),

    // Calendar — Claude MCP, slower
    getTodayEvents().then((events) =>
      events.length > 0 ? formatEvents(events) : null
    ),

    // Gmail — Claude MCP, slower
    getUnreadEmails().then((mails) =>
      mails.length > 0 ? formatEmails(mails) : null
    ),

    // Notion — direct API, fast
    isNotionAvailable()
      ? getActiveTasks().then((t) => (t.length > 0 ? formatTasks(t) : null))
      : Promise.resolve(null),
  ]);

  return {
    weather: weather.status === "fulfilled" ? weather.value : null,
    calendar: calendar.status === "fulfilled" ? calendar.value : null,
    emails: emails.status === "fulfilled" ? emails.value : null,
    tasks: tasks.status === "fulfilled" ? tasks.value : null,
  };
}

/**
 * Format the full context as a single string for prompt injection.
 * Skips sections that have no data.
 */
export function formatContext(ctx: IntegrationContext): string {
  const sections: string[] = [];

  if (ctx.weather) sections.push(`Weather: ${ctx.weather}`);
  if (ctx.calendar) sections.push(`Today's Schedule:\n${ctx.calendar}`);
  if (ctx.emails) sections.push(`Inbox:\n${ctx.emails}`);
  if (ctx.tasks) sections.push(`Active Tasks:\n${ctx.tasks}`);

  return sections.length > 0 ? sections.join("\n\n") : "";
}
