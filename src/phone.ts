/**
 * Phone Call Module (ElevenLabs + Twilio)
 *
 * Initiates outbound phone calls via ElevenLabs Conversational AI.
 * Returns gracefully when config is missing.
 */

import { log, logError } from "./logger";

interface CallResult {
  success: boolean;
  conversationId?: string;
}

export function isPhoneAvailable(): boolean {
  return !!(
    process.env.ELEVENLABS_API_KEY &&
    process.env.ELEVENLABS_AGENT_ID &&
    process.env.ELEVENLABS_PHONE_NUMBER_ID &&
    process.env.USER_PHONE_NUMBER
  );
}

export async function initiatePhoneCall(context: string): Promise<CallResult> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  const agentId = process.env.ELEVENLABS_AGENT_ID;
  const phoneNumberId = process.env.ELEVENLABS_PHONE_NUMBER_ID;
  const userPhone = process.env.USER_PHONE_NUMBER;
  const userName = process.env.USER_NAME || "there";

  if (!apiKey || !agentId || !phoneNumberId || !userPhone) {
    return { success: false };
  }

  try {
    const response = await fetch(
      "https://api.elevenlabs.io/v1/convai/twilio/outbound-call",
      {
        method: "POST",
        headers: {
          "xi-api-key": apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          agent_id: agentId,
          agent_phone_number_id: phoneNumberId,
          to_number: userPhone,
          conversation_initiation_client_data: {
            dynamic_variables: {
              user_name: userName,
              call_reason: context,
            },
          },
          first_message: `Hey! ${context}`,
        }),
      }
    );

    if (!response.ok) {
      logError("phone_error", `ElevenLabs call API returned ${response.status}`);
      return { success: false };
    }

    const data = (await response.json()) as { conversation_id?: string };
    log("phone_call_initiated", context, {
      metadata: { conversationId: data.conversation_id },
    });

    return { success: true, conversationId: data.conversation_id };
  } catch (error) {
    logError("phone_error", "Failed to initiate call", error);
    return { success: false };
  }
}
