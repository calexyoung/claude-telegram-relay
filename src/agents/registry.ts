/**
 * Agent Registry
 *
 * Defines the 6 specialized agents, loads their system prompts,
 * and maps Telegram forum topic IDs to agents.
 *
 * Topic mapping is auto-detected by topic name or configured
 * via config/agents.json.
 */

import { readFile } from "fs/promises";
import { join, dirname } from "path";
import { log, logError } from "../logger";

const PROJECT_ROOT = dirname(dirname(dirname(import.meta.path)));
const AGENTS_CONFIG_DIR = join(PROJECT_ROOT, "config", "agents");
const AGENTS_MAP_FILE = join(PROJECT_ROOT, "config", "agents.json");

// ============================================================
// TYPES
// ============================================================

export interface AgentConfig {
  name: string;
  slug: string; // lowercase identifier: "general", "research", etc.
  systemPrompt: string; // loaded from config/agents/<slug>.md
  topicId?: number; // Telegram forum topic ID (set at runtime)
}

export type AgentSlug =
  | "general"
  | "research"
  | "content"
  | "finance"
  | "strategy"
  | "critic";

// ============================================================
// REGISTRY
// ============================================================

const AGENT_SLUGS: AgentSlug[] = [
  "general",
  "research",
  "content",
  "finance",
  "strategy",
  "critic",
];

const agents: Map<AgentSlug, AgentConfig> = new Map();

// Topic ID → agent slug mapping (set during init)
const topicToAgent: Map<number, AgentSlug> = new Map();

// ============================================================
// INITIALIZATION
// ============================================================

let initialized = false;

/**
 * Load all agent system prompts from config/agents/*.md
 * and optionally load topic mappings from config/agents.json.
 */
export async function initAgents(): Promise<void> {
  if (initialized) return;

  for (const slug of AGENT_SLUGS) {
    let systemPrompt = "";
    try {
      systemPrompt = await readFile(join(AGENTS_CONFIG_DIR, `${slug}.md`), "utf-8");
    } catch {
      systemPrompt = `You are the ${slug} agent. Respond from the perspective of a ${slug} specialist.`;
      log("agent_prompt_fallback", `No prompt file for ${slug}, using default`, {
        level: "warn",
      });
    }

    agents.set(slug, {
      name: slug.charAt(0).toUpperCase() + slug.slice(1),
      slug,
      systemPrompt,
    });
  }

  // Try to load topic mappings from config/agents.json
  try {
    const content = await readFile(AGENTS_MAP_FILE, "utf-8");
    const mapping = JSON.parse(content) as Record<string, number>;
    for (const [slug, topicId] of Object.entries(mapping)) {
      if (AGENT_SLUGS.includes(slug as AgentSlug)) {
        const agent = agents.get(slug as AgentSlug);
        if (agent) {
          agent.topicId = topicId;
          topicToAgent.set(topicId, slug as AgentSlug);
        }
      }
    }
    log("agents_loaded", `Loaded topic mappings for ${topicToAgent.size} agents`);
  } catch {
    // No mapping file yet — topics will be auto-detected or created
    log("agents_loaded", "No agents.json found, topic mapping will use auto-detect");
  }

  initialized = true;
  log("agents_initialized", `${agents.size} agents loaded`);
}

// ============================================================
// LOOKUPS
// ============================================================

/**
 * Get an agent by its slug name.
 */
export function getAgent(slug: AgentSlug): AgentConfig | undefined {
  return agents.get(slug);
}

/**
 * Get an agent by Telegram forum topic ID.
 */
export function getAgentByTopicId(topicId: number): AgentConfig | undefined {
  const slug = topicToAgent.get(topicId);
  return slug ? agents.get(slug) : undefined;
}

/**
 * Get the General (orchestrator) agent.
 */
export function getGeneralAgent(): AgentConfig {
  return agents.get("general")!;
}

/**
 * Get all agents.
 */
export function getAllAgents(): AgentConfig[] {
  return Array.from(agents.values());
}

/**
 * Get all agents except General (for board meetings).
 */
export function getSpecialistAgents(): AgentConfig[] {
  return Array.from(agents.values()).filter((a) => a.slug !== "general");
}

/**
 * Get all agent slugs.
 */
export function getAgentSlugs(): AgentSlug[] {
  return [...AGENT_SLUGS];
}

// ============================================================
// TOPIC MANAGEMENT
// ============================================================

/**
 * Register a topic ID → agent mapping at runtime.
 * Called when auto-detecting topics from Telegram or after creating them.
 */
export function setAgentTopicId(slug: AgentSlug, topicId: number): void {
  const agent = agents.get(slug);
  if (agent) {
    agent.topicId = topicId;
    topicToAgent.set(topicId, slug);
  }
}

/**
 * Try to match a Telegram topic name to an agent slug.
 * Case-insensitive, matches both "Research" and "research".
 */
export function matchTopicNameToAgent(topicName: string): AgentSlug | undefined {
  const lower = topicName.toLowerCase().trim();
  for (const slug of AGENT_SLUGS) {
    if (lower === slug || lower.startsWith(slug)) {
      return slug;
    }
  }
  return undefined;
}

/**
 * Save the current topic mappings to config/agents.json.
 */
export async function saveTopicMappings(): Promise<void> {
  const mapping: Record<string, number> = {};
  for (const [slug, agent] of agents) {
    if (agent.topicId) {
      mapping[slug] = agent.topicId;
    }
  }

  try {
    const { writeFile } = await import("fs/promises");
    await writeFile(AGENTS_MAP_FILE, JSON.stringify(mapping, null, 2));
    log("agents_mapping_saved", `Saved ${Object.keys(mapping).length} topic mappings`);
  } catch (err) {
    logError("agents_mapping_save_error", "Failed to save topic mappings", err);
  }
}

/**
 * Check if forum topics are configured (at least one agent has a topic ID).
 */
export function isForumMode(): boolean {
  for (const agent of agents.values()) {
    if (agent.topicId) return true;
  }
  return false;
}
