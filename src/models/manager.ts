/**
 * Model Assignment Manager
 *
 * Routes agent requests to different AI providers based on
 * per-agent configuration stored in Supabase `model_config` table.
 * Uses in-memory cache with 60s TTL to avoid DB hits on every message.
 */

import { getSupabase } from "../supabase";
import { logError } from "../logger";

export interface ModelConfig {
  agent: string;
  provider: "claude" | "openrouter" | "ollama";
  model: string;
  enabled: boolean;
}

let configCache: Map<string, ModelConfig> = new Map();
let lastFetch = 0;
const CACHE_TTL = 60_000; // 1 minute

const DEFAULT_CONFIG: ModelConfig = {
  agent: "general",
  provider: "claude",
  model: "claude-cli",
  enabled: true,
};

/**
 * Get model config for an agent, with caching.
 */
export async function getModelForAgent(agentSlug: string): Promise<ModelConfig> {
  const now = Date.now();
  if (now - lastFetch > CACHE_TTL || configCache.size === 0) {
    await refreshConfigCache();
  }

  return configCache.get(agentSlug) || { ...DEFAULT_CONFIG, agent: agentSlug };
}

/**
 * Get all model configs (for dashboard).
 */
export async function getAllModelConfigs(): Promise<ModelConfig[]> {
  const now = Date.now();
  if (now - lastFetch > CACHE_TTL || configCache.size === 0) {
    await refreshConfigCache();
  }
  return Array.from(configCache.values());
}

/**
 * Refresh the in-memory cache from Supabase.
 */
async function refreshConfigCache(): Promise<void> {
  const sb = getSupabase();
  if (!sb) return;

  try {
    const { data, error } = await sb.from("model_config").select("*");

    if (error) {
      logError("model_config_fetch_error", "Failed to fetch model configs", error);
      return;
    }

    if (data) {
      configCache.clear();
      for (const row of data) {
        configCache.set(row.agent, {
          agent: row.agent,
          provider: row.provider,
          model: row.model,
          enabled: row.enabled,
        });
      }
      lastFetch = Date.now();
    }
  } catch (err) {
    logError("model_config_fetch_error", "Failed to refresh model config cache", err);
  }
}

/**
 * Update model assignment for an agent.
 */
export async function setModelForAgent(
  agent: string,
  provider: "claude" | "openrouter" | "ollama",
  model: string,
): Promise<void> {
  const sb = getSupabase();
  if (!sb) throw new Error("Database unavailable");

  const { error } = await sb
    .from("model_config")
    .upsert(
      {
        agent,
        provider,
        model,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "agent" },
    );

  if (error) throw error;

  // Invalidate cache
  lastFetch = 0;
}
