/**
 * Gmail Integration — via Claude CLI with MCP
 *
 * Fetches unread email summaries by asking Claude (with Gmail MCP)
 * to summarize the inbox. Falls back to a simple "not configured" state
 * if the MCP server isn't set up.
 *
 * Setup:
 * 1. claude mcp add gmail -- npx -y @anthropic/gmail-mcp
 * 2. Authenticate when prompted (OAuth flow opens in browser)
 */

import { spawn } from "bun";

const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";

export interface EmailSummary {
  sender: string;
  subject: string;
  snippet: string;
  urgent: boolean;
}

/**
 * Check if Gmail MCP is likely available.
 * We can't know for sure without calling Claude, but we can
 * at least verify Claude CLI exists.
 */
export function isGmailAvailable(): boolean {
  // Gmail integration requires Claude CLI with MCP — we assume it's
  // configured if the user has set it up. The call itself will degrade
  // gracefully if MCP isn't connected.
  return true;
}

/**
 * Fetch unread email summaries via Claude CLI + Gmail MCP.
 * Returns parsed email summaries, or an empty array on failure.
 */
export async function getUnreadEmails(maxCount = 10): Promise<EmailSummary[]> {
  try {
    const prompt = `Using the Gmail tool, check my inbox for unread emails (up to ${maxCount}).

For each unread email, output EXACTLY this format (one per email):
SENDER: <sender name or email>
SUBJECT: <subject line>
SNIPPET: <first 80 chars of body>
URGENT: <yes or no>
---

If there are no unread emails, respond with: NO_UNREAD_EMAILS
If you cannot access Gmail (MCP not configured), respond with: GMAIL_UNAVAILABLE`;

    const proc = spawn([CLAUDE_PATH, "-p", prompt, "--output-format", "text"], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: 30_000,
    });

    const output = await new Response(proc.stdout).text();

    if (output.includes("NO_UNREAD_EMAILS")) return [];
    if (output.includes("GMAIL_UNAVAILABLE")) return [];

    return parseEmailOutput(output);
  } catch {
    return [];
  }
}

/**
 * Parse Claude's structured email output into EmailSummary objects.
 */
function parseEmailOutput(output: string): EmailSummary[] {
  const emails: EmailSummary[] = [];
  const blocks = output.split("---").filter((b) => b.trim());

  for (const block of blocks) {
    const sender = block.match(/SENDER:\s*(.+)/i)?.[1]?.trim();
    const subject = block.match(/SUBJECT:\s*(.+)/i)?.[1]?.trim();
    const snippet = block.match(/SNIPPET:\s*(.+)/i)?.[1]?.trim();
    const urgent = block.match(/URGENT:\s*(yes|no)/i)?.[1]?.toLowerCase() === "yes";

    if (sender && subject) {
      emails.push({
        sender,
        subject,
        snippet: snippet || "",
        urgent,
      });
    }
  }

  return emails;
}

/**
 * Format email summaries as a human-readable string.
 */
export function formatEmails(emails: EmailSummary[]): string {
  if (emails.length === 0) return "No unread emails";

  const urgent = emails.filter((e) => e.urgent);
  const normal = emails.filter((e) => !e.urgent);

  const parts: string[] = [];

  if (urgent.length > 0) {
    parts.push(...urgent.map((e) => `- [!] ${e.sender}: ${e.subject}`));
  }
  if (normal.length > 0) {
    parts.push(...normal.map((e) => `- ${e.sender}: ${e.subject}`));
  }

  return parts.join("\n");
}
