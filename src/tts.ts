/**
 * Text-to-Speech Module (ElevenLabs)
 *
 * Converts text to audio via ElevenLabs API.
 * Returns null when API key is missing or request fails.
 */

import { log, logError } from "./logger";

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM"; // Rachel

export function isTTSAvailable(): boolean {
  return !!ELEVENLABS_API_KEY;
}

export async function textToSpeech(text: string): Promise<Buffer | null> {
  if (!ELEVENLABS_API_KEY) return null;

  // ElevenLabs has a ~5000 char limit per request
  const truncated = text.length > 4500 ? text.substring(0, 4500) + "..." : text;

  try {
    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`,
      {
        method: "POST",
        headers: {
          Accept: "audio/mpeg",
          "Content-Type": "application/json",
          "xi-api-key": ELEVENLABS_API_KEY,
        },
        body: JSON.stringify({
          text: truncated,
          model_id: "eleven_multilingual_v2",
          voice_settings: { stability: 0.5, similarity_boost: 0.75 },
        }),
      }
    );

    if (!response.ok) {
      logError("tts_error", `ElevenLabs returned ${response.status}`);
      return null;
    }

    log("tts_success", `Generated audio for ${truncated.length} chars`);
    return Buffer.from(await response.arrayBuffer());
  } catch (error) {
    logError("tts_error", "Failed to generate speech", error);
    return null;
  }
}
