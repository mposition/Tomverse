import { parseChatLocation, type ChatLocation } from "@tomverse/chat-core";
import type { ModelMessage } from "ai";
import { ANTHROPIC_PROMPT_CACHE_TTL } from "@/lib/anthropicPromptCaching";

const rules = "# Current device location\nUse the current device location only when the user's question depends on where they are (for example nearby places, local weather, or directions). Honor a place explicitly named by the user over the device fix. A location fix is approximate and is not continuous tracking. Only use a device fix attached to the current user message; never infer current location from language, timezone, IP, memory, or older messages. The app automatically requests location permission when a question needs it and reuses existing permission. If no current fix is supplied, do not say the user must attach GPS data or describe payloads, fixes or JSON. Briefly explain that current location is unavailable and ask for a place or suggest retrying Current location in the + tools menu. Do not claim to have read GPS yourself. Location alone does not provide live weather, opening hours, or other current facts; use available search tools or explain the limitation.";

/** Keep the system prefix byte-identical across turns for provider caching. */
export const buildChatLocationPrompt = () => rules;

export const buildChatLocationContext = (value?: ChatLocation | null) => {
  const location = parseChatLocation(value);
  return location
    ? `Approximate device location for this turn only: ${JSON.stringify(location)}. Timestamp: Unix ms; accuracy: metres. Use only for location-dependent questions; prefer a place named by the user. No continuous tracking or live-fact guarantee; search for current facts.`
    : "";
};

/** Ephemeral request enrichment, after the stable history and outside system. */
export const appendChatLocationContext = (messages: ModelMessage[], value?: ChatLocation | null, cacheStablePrefix = false) => {
  const context = buildChatLocationContext(value);
  if (!context) return;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== "user") continue;
    const parts = typeof message.content === "string"
      ? [{ type: "text" as const, text: message.content }]
      : [...message.content];
    // Cache complete history messages only, before the current user turn.
    // The current turn's part/message boundaries change when its transient
    // fix is omitted on replay, so neither that turn nor the fix is cached.
    let historyBreakpoint: number | null = null;
    if (cacheStablePrefix) {
      for (let previous = index - 1; previous >= 0; previous--) {
        const history = messages[previous];
        if ((history.role !== "user" && history.role !== "assistant") ||
          (typeof history.content === "string" ? !history.content.trim() :
            !history.content.some((part, partIndex) => partIndex === history.content.length - 1 && part.type === "text" && part.text.trim()))) continue;
        messages[previous] = { ...history, providerOptions: {
          ...history.providerOptions,
          anthropic: { ...history.providerOptions?.anthropic,
            cacheControl: { type: "ephemeral", ttl: ANTHROPIC_PROMPT_CACHE_TTL } },
        } };
        historyBreakpoint = previous;
        break;
      }
    }
    messages[index] = { ...message, content: [...parts, { type: "text", text: context }] };
    // Also suppress automatic caching on a first turn with no reusable history.
    return cacheStablePrefix ? { historyBreakpoint } : undefined;
  }
};

/** A comparison quotes before panels acquire their fresh foreground fixes. */
export const CHAT_LOCATION_INPUT_TOKEN_RESERVE = 160;
