/**
 * Token Usage Tracker
 *
 * Instruments AI provider calls to log token usage and costs.
 * Stores in Supabase `token_usage` table for dashboard analytics.
 */

import { getSupabase } from "../supabase";
import { logError } from "../logger";

export interface TokenUsage {
  provider: "claude" | "openrouter" | "ollama";
  model: string;
  agent?: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUSD: number;
  durationMs?: number;
  sessionId?: string;
}

// Pricing per million tokens: { input: $/MTok, output: $/MTok }
const PRICING: Record<string, { input: number; output: number }> = {
  "claude-cli": { input: 0, output: 0 },
  "anthropic/claude-sonnet-4": { input: 3, output: 15 },
  "anthropic/claude-sonnet-4-5-20250929": { input: 3, output: 15 },
  "anthropic/claude-opus-4": { input: 15, output: 75 },
  "anthropic/claude-haiku-4": { input: 0.25, output: 1.25 },
  "openai/gpt-4o": { input: 2.5, output: 10 },
  "openai/gpt-4o-mini": { input: 0.15, output: 0.6 },
  "google/gemini-2.0-flash": { input: 0.1, output: 0.4 },
  "llama3.2": { input: 0, output: 0 },
  "mistral": { input: 0, output: 0 },
  "codellama": { input: 0, output: 0 },
};

/**
 * Calculate cost based on model pricing.
 */
export function calculateCost(
  model: string,
  promptTokens: number,
  completionTokens: number,
): number {
  const pricing = PRICING[model] || { input: 0, output: 0 };
  const inputCost = (promptTokens / 1_000_000) * pricing.input;
  const outputCost = (completionTokens / 1_000_000) * pricing.output;
  return inputCost + outputCost;
}

/**
 * Estimate token counts from text (rough: ~4 chars per token).
 */
export function estimateTokens(
  prompt: string,
  response: string,
): { prompt: number; completion: number; total: number } {
  const promptTokens = Math.ceil(prompt.length / 4);
  const completionTokens = Math.ceil(response.length / 4);
  return {
    prompt: promptTokens,
    completion: completionTokens,
    total: promptTokens + completionTokens,
  };
}

/**
 * Record token usage to Supabase (fire-and-forget).
 */
export async function trackTokenUsage(usage: TokenUsage): Promise<void> {
  const sb = getSupabase();
  if (!sb) return;

  const { error } = await sb.from("token_usage").insert({
    provider: usage.provider,
    model: usage.model,
    agent: usage.agent || "general",
    prompt_tokens: usage.promptTokens,
    completion_tokens: usage.completionTokens,
    total_tokens: usage.totalTokens,
    cost_usd: usage.costUSD,
    duration_ms: usage.durationMs,
    session_id: usage.sessionId,
  });

  if (error) {
    logError("token_tracking_error", "Failed to track token usage", error);
  }
}

/**
 * Get available pricing models for the dashboard.
 */
export function getAvailableModels(): Record<string, string[]> {
  return {
    claude: ["claude-cli"],
    openrouter: [
      "anthropic/claude-sonnet-4",
      "anthropic/claude-opus-4",
      "anthropic/claude-haiku-4",
      "openai/gpt-4o",
      "openai/gpt-4o-mini",
      "google/gemini-2.0-flash",
    ],
    ollama: ["llama3.2", "mistral", "codellama"],
  };
}
