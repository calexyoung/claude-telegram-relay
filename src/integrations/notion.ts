/**
 * Notion Integration — Direct API
 *
 * Fetches active tasks from a Notion database.
 * Requires: NOTION_API_KEY and NOTION_DATABASE_ID
 *
 * Setup:
 * 1. Create an integration at notion.so/my-integrations
 * 2. Share your tasks database with the integration
 * 3. Copy the API key and database ID to .env
 */

const API_KEY = process.env.NOTION_API_KEY || "";
const DATABASE_ID = process.env.NOTION_DATABASE_ID || "";
const NOTION_API = "https://api.notion.com/v1";

export interface NotionTask {
  title: string;
  status: string;
  dueDate: string | null;
  project: string | null;
  url: string;
}

export function isNotionAvailable(): boolean {
  return !!API_KEY && !API_KEY.includes("your_") && !!DATABASE_ID && !DATABASE_ID.includes("your_");
}

/**
 * Fetch active (non-done) tasks from the configured Notion database.
 */
export async function getActiveTasks(): Promise<NotionTask[]> {
  if (!isNotionAvailable()) return [];

  try {
    const res = await fetch(`${NOTION_API}/databases/${DATABASE_ID}/query`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
        "Notion-Version": "2022-06-28",
      },
      body: JSON.stringify({
        filter: {
          and: [
            {
              property: "Status",
              status: { does_not_equal: "Done" },
            },
          ],
        },
        sorts: [
          { property: "Due", direction: "ascending" },
        ],
        page_size: 20,
      }),
    });

    if (!res.ok) {
      // Try alternative filter for checkbox-style "Done" property
      const altRes = await fetch(`${NOTION_API}/databases/${DATABASE_ID}/query`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          "Content-Type": "application/json",
          "Notion-Version": "2022-06-28",
        },
        body: JSON.stringify({
          page_size: 20,
        }),
      });

      if (!altRes.ok) return [];

      const altData = await altRes.json();
      return parseNotionResults(altData);
    }

    const data = await res.json();
    return parseNotionResults(data);
  } catch {
    return [];
  }
}

/**
 * Parse Notion query results into a flat task list.
 * Handles various property types (title, rich_text, status, select, date).
 */
function parseNotionResults(data: any): NotionTask[] {
  const results = data.results || [];
  return results.map((page: any) => {
    const props = page.properties || {};

    return {
      title: extractTitle(props),
      status: extractStatus(props),
      dueDate: extractDate(props, "Due") || extractDate(props, "Due Date") || extractDate(props, "Deadline"),
      project: extractSelect(props, "Project") || extractSelect(props, "Category"),
      url: page.url || "",
    };
  });
}

function extractTitle(props: any): string {
  // Find the title property (could be named anything)
  for (const [, value] of Object.entries(props) as Array<[string, any]>) {
    if (value.type === "title" && value.title?.length > 0) {
      return value.title.map((t: any) => t.plain_text).join("");
    }
  }
  return "Untitled";
}

function extractStatus(props: any): string {
  // Try "Status" as status type
  if (props.Status?.status?.name) return props.Status.status.name;
  // Try as select
  if (props.Status?.select?.name) return props.Status.select.name;
  // Try checkbox
  if (props.Done?.checkbox !== undefined) return props.Done.checkbox ? "Done" : "In Progress";
  return "Unknown";
}

function extractDate(props: any, name: string): string | null {
  const prop = props[name];
  if (!prop || prop.type !== "date" || !prop.date?.start) return null;
  return prop.date.start; // ISO date string
}

function extractSelect(props: any, name: string): string | null {
  const prop = props[name];
  if (!prop) return null;
  if (prop.type === "select" && prop.select?.name) return prop.select.name;
  if (prop.type === "multi_select" && prop.multi_select?.length > 0) {
    return prop.multi_select.map((s: any) => s.name).join(", ");
  }
  return null;
}

/**
 * Format tasks as a human-readable string.
 */
export function formatTasks(tasks: NotionTask[]): string {
  if (tasks.length === 0) return "No active tasks";
  return tasks
    .map((t) => {
      const due = t.dueDate ? ` (due ${t.dueDate})` : "";
      const project = t.project ? ` [${t.project}]` : "";
      return `- ${t.title}${due}${project} — ${t.status}`;
    })
    .join("\n");
}
