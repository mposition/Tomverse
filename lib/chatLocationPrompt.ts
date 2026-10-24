import { parseChatLocation, type ChatLocation } from "@tomverse/chat-core";

const rules = "# Current device location\nUse the current device location only when the user's question depends on where they are (for example nearby places, local weather, or directions). A location fix is approximate and is not continuous tracking. Never infer current location from language, timezone, IP, memory, or older messages. If no current fix is supplied and location is needed, ask the user to enable Current location in the + tools menu or provide a place. Do not claim to have read GPS yourself. Location alone does not provide live weather, opening hours, or other current facts; use available search tools or explain the limitation.";

export const buildChatLocationPrompt = (value?: ChatLocation | null) => {
  const location = parseChatLocation(value);
  return location
    ? `${rules}\nUser-shared device fix for this turn: ${JSON.stringify(location)}. Timestamp is Unix milliseconds; accuracy is a radius in metres. Use this fix instead of any older location.`
    : `${rules}\nNo current device location was shared for this turn.`;
};

/** A comparison quotes before panels acquire their fresh foreground fixes. */
export const CHAT_LOCATION_INPUT_TOKEN_RESERVE = 160;
