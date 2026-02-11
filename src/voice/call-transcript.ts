/**
 * Post-Call Transcript Processing
 *
 * After an outbound phone call via ElevenLabs + Twilio, this module:
 * 1. Polls the ElevenLabs API until the conversation is complete
 * 2. Extracts the full transcript
 * 3. Sends it to Claude for summarization and action item extraction
 * 4. Stores action items as goals in memory
 * 5. Returns the summary for posting to Telegram
 *
 * Requires: ELEVENLABS_API_KEY
 */

import { spawn } from "bun";
import { log, logError } from "../logger";
import { saveGoal } from "../memory";

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || "";
const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";

interface TranscriptMessage {
  role: "agent" | "user";
  message: string;
  timestamp?: number;
}

export interface CallTranscriptResult {
  conversationId: string;
  status: "completed" | "failed" | "timeout";
  transcript: TranscriptMessage[];
  summary: string;
  actionItems: string[];
  durationSeconds: number;
}

/**
 * Poll ElevenLabs for conversation completion, then extract and process transcript.
 *
 * @param conversationId - The conversation ID returned by initiatePhoneCall()
 * @param maxWaitMs - Maximum time to wait for call completion (default: 10 minutes)
 * @param pollIntervalMs - How often to check (default: 10 seconds)
 */
export async function processCallTranscript(
  conversationId: string,
  maxWaitMs = 600_000,
  pollIntervalMs = 10_000,
): Promise<CallTranscriptResult> {
  if (!ELEVENLABS_API_KEY) {
    return {
      conversationId,
      status: "failed",
      transcript: [],
      summary: "ElevenLabs API key not configured",
      actionItems: [],
      durationSeconds: 0,
    };
  }

  log("transcript_polling_start", `Polling conversation ${conversationId}`);

  // 1. Poll until conversation is complete
  const startTime = Date.now();
  let conversationData: any = null;

  while (Date.now() - startTime < maxWaitMs) {
    try {
      const res = await fetch(
        `https://api.elevenlabs.io/v1/convai/conversations/${conversationId}`,
        {
          headers: { "xi-api-key": ELEVENLABS_API_KEY },
        },
      );

      if (!res.ok) {
        logError("transcript_poll_error", `API returned ${res.status}`);
        await sleep(pollIntervalMs);
        continue;
      }

      conversationData = await res.json();
      const status = conversationData.status;

      if (status === "done" || status === "completed") {
        log("transcript_poll_complete", `Conversation completed after ${Math.round((Date.now() - startTime) / 1000)}s`);
        break;
      }

      if (status === "failed" || status === "error") {
        return {
          conversationId,
          status: "failed",
          transcript: [],
          summary: `Call failed with status: ${status}`,
          actionItems: [],
          durationSeconds: Math.round((Date.now() - startTime) / 1000),
        };
      }

      // Still in progress
      await sleep(pollIntervalMs);
    } catch (err) {
      logError("transcript_poll_error", "Failed to poll conversation", err);
      await sleep(pollIntervalMs);
    }
  }

  if (!conversationData || (conversationData.status !== "done" && conversationData.status !== "completed")) {
    return {
      conversationId,
      status: "timeout",
      transcript: [],
      summary: "Call transcript timed out waiting for completion",
      actionItems: [],
      durationSeconds: Math.round((Date.now() - startTime) / 1000),
    };
  }

  // 2. Extract transcript
  const transcript = extractTranscript(conversationData);

  if (transcript.length === 0) {
    return {
      conversationId,
      status: "completed",
      transcript: [],
      summary: "Call completed but no transcript was available",
      actionItems: [],
      durationSeconds: conversationData.metadata?.call_duration_secs || 0,
    };
  }

  // 3. Summarize and extract action items via Claude
  const { summary, actionItems } = await summarizeTranscript(transcript);

  // 4. Store action items as goals in memory
  for (const item of actionItems) {
    await saveGoal(item);
  }

  if (actionItems.length > 0) {
    log("transcript_action_items", `Saved ${actionItems.length} action items from call`);
  }

  return {
    conversationId,
    status: "completed",
    transcript,
    summary,
    actionItems,
    durationSeconds: conversationData.metadata?.call_duration_secs || 0,
  };
}

/**
 * Extract transcript messages from the ElevenLabs conversation response.
 */
function extractTranscript(data: any): TranscriptMessage[] {
  const messages: TranscriptMessage[] = [];

  // ElevenLabs conversation data may have different structures
  const transcript = data.transcript || data.messages || data.conversation?.messages || [];

  for (const msg of transcript) {
    const role = msg.role === "agent" || msg.role === "assistant" ? "agent" : "user";
    const message = msg.message || msg.text || msg.content || "";

    if (message.trim()) {
      messages.push({
        role,
        message: message.trim(),
        timestamp: msg.timestamp || msg.time,
      });
    }
  }

  return messages;
}

/**
 * Send transcript to Claude for summarization and action item extraction.
 */
async function summarizeTranscript(
  transcript: TranscriptMessage[],
): Promise<{ summary: string; actionItems: string[] }> {
  const transcriptText = transcript
    .map((m) => `${m.role === "agent" ? "AI" : "User"}: ${m.message}`)
    .join("\n");

  const prompt = `Summarize this phone call transcript concisely. Then extract any action items or commitments made.

TRANSCRIPT:
${transcriptText}

RESPOND IN THIS EXACT FORMAT:
SUMMARY: <2-3 sentence summary of the call>
ACTION_ITEMS:
- <action item 1>
- <action item 2>
(or "none" if no action items)`;

  try {
    const proc = spawn([CLAUDE_PATH, "-p", prompt, "--output-format", "text"], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: 30_000,
    });

    const output = await new Response(proc.stdout).text();

    // Parse summary
    const summaryMatch = output.match(/SUMMARY:\s*(.+?)(?=\nACTION_ITEMS:|$)/is);
    const summary = summaryMatch?.[1]?.trim() || "Call completed (summary unavailable)";

    // Parse action items
    const actionItems: string[] = [];
    const actionSection = output.match(/ACTION_ITEMS:\s*([\s\S]*)/i)?.[1] || "";

    if (!actionSection.toLowerCase().includes("none")) {
      const items = actionSection.match(/^-\s+(.+)$/gm);
      if (items) {
        for (const item of items) {
          const text = item.replace(/^-\s+/, "").trim();
          if (text) actionItems.push(text);
        }
      }
    }

    return { summary, actionItems };
  } catch (err) {
    logError("transcript_summarize_error", "Failed to summarize transcript", err);
    return {
      summary: "Call completed (summarization failed)",
      actionItems: [],
    };
  }
}

/**
 * Format a transcript result as a human-readable Telegram message.
 */
export function formatTranscriptResult(result: CallTranscriptResult): string {
  const parts: string[] = [];

  parts.push(`Phone Call ${result.status === "completed" ? "Complete" : "Update"}`);

  if (result.durationSeconds > 0) {
    const mins = Math.floor(result.durationSeconds / 60);
    const secs = result.durationSeconds % 60;
    parts.push(`Duration: ${mins}m ${secs}s`);
  }

  parts.push("");
  parts.push(result.summary);

  if (result.actionItems.length > 0) {
    parts.push("");
    parts.push("Action Items:");
    for (const item of result.actionItems) {
      parts.push(`- ${item}`);
    }
    parts.push("(saved to goals)");
  }

  return parts.join("\n");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
