/**
 * Board Meeting Orchestrator
 *
 * Fans a prompt to all specialist agents in parallel,
 * collects responses, and synthesizes a summary.
 */

import { getSpecialistAgents, getGeneralAgent, type AgentConfig } from "./registry";
import { log, logError } from "../logger";

// ============================================================
// TYPES
// ============================================================

export interface AgentResponse {
  agent: AgentConfig;
  response: string;
  durationMs: number;
  error?: string;
}

export interface BoardMeetingResult {
  question: string;
  responses: AgentResponse[];
  synthesis: string;
  totalDurationMs: number;
}

// Type for the Claude-calling function injected from relay.ts
export type CallClaudeFn = (prompt: string) => Promise<string>;

// ============================================================
// BOARD MEETING
// ============================================================

/**
 * Run a board meeting: send the question to all specialist agents,
 * collect their responses, then synthesize.
 *
 * @param question - The user's question
 * @param callClaude - Function to call Claude CLI with a prompt
 * @param profileContext - User's profile.md content for context
 */
export async function runBoardMeeting(
  question: string,
  callClaude: CallClaudeFn,
  profileContext?: string,
): Promise<BoardMeetingResult> {
  const startTime = Date.now();
  const specialists = getSpecialistAgents();

  log("board_meeting_start", `Question: ${question.substring(0, 80)}`, {
    metadata: { agentCount: specialists.length },
  });

  // Fan out to all specialists in parallel
  const responsePromises = specialists.map((agent) =>
    callAgentForMeeting(agent, question, callClaude, profileContext)
  );

  const responses = await Promise.all(responsePromises);

  // Count successes
  const successes = responses.filter((r) => !r.error).length;
  log("board_meeting_responses", `${successes}/${specialists.length} agents responded`);

  // Synthesize
  const synthesis = await synthesizeResponses(question, responses, callClaude);
  const totalDurationMs = Date.now() - startTime;

  log("board_meeting_complete", `Synthesized in ${totalDurationMs}ms`, {
    durationMs: totalDurationMs,
  });

  return { question, responses, synthesis, totalDurationMs };
}

// ============================================================
// INTERNAL
// ============================================================

async function callAgentForMeeting(
  agent: AgentConfig,
  question: string,
  callClaude: CallClaudeFn,
  profileContext?: string,
): Promise<AgentResponse> {
  const startTime = Date.now();

  const prompt = [
    agent.systemPrompt,
    profileContext ? `\nUser profile:\n${profileContext}` : "",
    `\nYou are participating in a board meeting. Multiple specialist agents are being consulted on the same question. Provide your perspective based on your specialty.`,
    `\nKeep your response focused and under 300 words.`,
    `\nQuestion: ${question}`,
  ].join("\n");

  try {
    const response = await callClaude(prompt);
    const durationMs = Date.now() - startTime;

    log("board_agent_responded", `${agent.name}: ${response.length} chars`, {
      durationMs,
      metadata: { agent: agent.slug },
    });

    return { agent, response, durationMs };
  } catch (err) {
    const durationMs = Date.now() - startTime;
    const errorMsg = err instanceof Error ? err.message : String(err);

    logError("board_agent_error", `${agent.name} failed: ${errorMsg}`, err);

    return {
      agent,
      response: `[${agent.name} agent was unable to respond]`,
      durationMs,
      error: errorMsg,
    };
  }
}

async function synthesizeResponses(
  question: string,
  responses: AgentResponse[],
  callClaude: CallClaudeFn,
): Promise<string> {
  const general = getGeneralAgent();

  const agentSummaries = responses
    .map((r) => `### ${r.agent.name}\n${r.response}`)
    .join("\n\n");

  const prompt = [
    general.systemPrompt,
    `\nYou are synthesizing a board meeting. Multiple specialist agents have weighed in on the same question. Your job:`,
    `1. Identify points of consensus`,
    `2. Highlight key disagreements or different perspectives`,
    `3. Provide a clear, actionable recommendation`,
    `4. Keep the synthesis concise (under 250 words)`,
    `\nOriginal question: ${question}`,
    `\n--- Agent Responses ---\n`,
    agentSummaries,
    `\n--- End of Responses ---`,
    `\nSynthesize the above into a clear summary with recommendation.`,
  ].join("\n");

  try {
    return await callClaude(prompt);
  } catch (err) {
    logError("board_synthesis_error", "Failed to synthesize board meeting", err);
    return "Could not synthesize board meeting responses. See individual agent responses above.";
  }
}
