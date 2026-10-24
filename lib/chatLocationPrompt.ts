import { parseChatLocation, type ChatLocation } from "@tomverse/chat-core";
import type { ModelMessage } from "ai";

const rules = "# Current device location\nUse the current device location only when the user's question depends on where they are (for example nearby places, local weather, or directions). Honor a place explicitly named by the user over the device fix. A location fix is approximate and is not continuous tracking. Only use a device fix attached to the current user message; never infer current location from language, timezone, IP, memory, or older messages. If no current fix is supplied and location is needed, ask the user to enable Current location in the + tools menu or provide a place. Do not claim to have read GPS yourself. Location alone does not provide live weather, opening hours, or other current facts; use available search tools or explain the limitation.";

/** Keep the system prefix byte-identical across turns for provider caching. */
export const buildChatLocationPrompt = () => rules;

export const buildChatLocationContext = (value?: ChatLocation | null) => {
  const location = parseChatLocation(value);
  return location
    ? `User-shared device fix for this turn: ${JSON.stringify(location)}. Timestamp is Unix milliseconds; accuracy is a radius in metres. Use this fix instead of any older location.`
    : "";
};

/** Ephemeral request enrichment, after the stable history and outside system. */
export const appendChatLocationContext = (messages: ModelMessage[], value?: ChatLocation | null) => {
  const context = buildChatLocationContext(value);
  if (!context) return;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== "user") continue;
    messages[index] = { ...message, content: typeof message.content === "string"
      ? `${message.content}\n\n${context}`
      : [...message.content, { type: "text", text: context }] };
    return;
  }
};

/** A comparison quotes before panels acquire their fresh foreground fixes. */
export const CHAT_LOCATION_INPUT_TOKEN_RESERVE = 160;
