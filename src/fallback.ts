/**
 * Fallback AI Provider Chain
 *
 * When Claude CLI is unavailable (rate limits, outages, network issues),
 * falls back to OpenRouter (cloud) or Ollama (local).
 *
 * Chain: Claude CLI → OpenRouter → Ollama → error message
 */

import { log, logError } from "./logger";

// ============================================================
// CONFIGURATION
// ============================================================

const FALLBACK_ENABLED = (process.env.FALLBACK_ENABLED ?? "true") !== "false";

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "";
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || "anthropic/claude-sonnet-4";

const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "llama3.2";

// ============================================================
// PROVIDER STATUS
// ============================================================

export interface ProviderResult {
  text: string;
  provider: "claude" | "openrouter" | "ollama" | "error";
  durationMs?: number;
}

export function isFallbackEnabled(): boolean {
  return FALLBACK_ENABLED;
}

export function isOpenRouterAvailable(): boolean {
  return !!OPENROUTER_API_KEY && !OPENROUTER_API_KEY.includes("your_");
}

export function isOllamaConfigured(): boolean {
  return !!OLLAMA_URL;
}

// ============================================================
// OPENROUTER
// ============================================================

export async function callOpenRouter(prompt: string): Promise<string> {
  if (!isOpenRouterAvailable()) {
    throw new Error("OpenRouter API key not configured");
  }

  const startTime = Date.now();

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "HTTP-Referer": "https://github.com/godagoo/claude-telegram-relay",
      "X-Title": "Claude Telegram Relay",
    },
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      messages: [{ role: "user", content: prompt }],
      max_tokens: 4096,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`OpenRouter ${response.status}: ${body.substring(0, 200)}`);
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    error?: { message?: string };
  };

  if (data.error) {
    throw new Error(`OpenRouter error: ${data.error.message}`);
  }

  const text = data.choices?.[0]?.message?.content?.trim();
  if (!text) {
    throw new Error("OpenRouter returned empty response");
  }

  const durationMs = Date.now() - startTime;
  log("openrouter_response", `${text.length} chars`, {
    durationMs,
    metadata: { model: OPENROUTER_MODEL },
  });

  return text;
}

// ============================================================
// OLLAMA
// ============================================================

export async function callOllama(prompt: string): Promise<string> {
  const startTime = Date.now();

  const response = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      prompt,
      stream: false,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Ollama ${response.status}: ${body.substring(0, 200)}`);
  }

  const data = (await response.json()) as {
    response?: string;
    error?: string;
  };

  if (data.error) {
    throw new Error(`Ollama error: ${data.error}`);
  }

  const text = data.response?.trim();
  if (!text) {
    throw new Error("Ollama returned empty response");
  }

  const durationMs = Date.now() - startTime;
  log("ollama_response", `${text.length} chars`, {
    durationMs,
    metadata: { model: OLLAMA_MODEL },
  });

  return text;
}

// ============================================================
// FALLBACK CHAIN
// ============================================================

/**
 * Try fallback providers after Claude fails.
 * Returns a ProviderResult with the response text and which provider served it.
 */
export async function tryFallbacks(prompt: string): Promise<ProviderResult> {
  if (!FALLBACK_ENABLED) {
    return {
      text: "Claude is temporarily unavailable. Please try again in a moment.",
      provider: "error",
    };
  }

  // Try OpenRouter
  if (isOpenRouterAvailable()) {
    try {
      log("fallback_trying", "Attempting OpenRouter", {
        metadata: { model: OPENROUTER_MODEL },
      });
      const startTime = Date.now();
      const text = await callOpenRouter(prompt);
      return {
        text,
        provider: "openrouter",
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      logError("openrouter_error", "OpenRouter failed", err);
    }
  }

  // Try Ollama
  if (isOllamaConfigured()) {
    try {
      log("fallback_trying", "Attempting Ollama", {
        metadata: { model: OLLAMA_MODEL, url: OLLAMA_URL },
      });
      const startTime = Date.now();
      const text = await callOllama(prompt);
      return {
        text,
        provider: "ollama",
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      logError("ollama_error", "Ollama failed", err);
    }
  }

  // All providers failed
  const available = [
    isOpenRouterAvailable() ? "OpenRouter" : null,
    isOllamaConfigured() ? "Ollama" : null,
  ]
    .filter(Boolean)
    .join(", ");

  return {
    text: available
      ? `All AI providers are currently unavailable (tried: Claude, ${available}). Please try again later.`
      : "Claude is temporarily unavailable and no fallback providers are configured. Add OPENROUTER_API_KEY or set up Ollama for resilience.",
    provider: "error",
  };
}
