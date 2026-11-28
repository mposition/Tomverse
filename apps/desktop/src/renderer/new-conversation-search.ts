import { APP_DEFAULTS, normalizeWebSearchMode } from "../../../../lib/appDefaults";
import type { ComposerOptions } from "../chat-contract";

/** The web search position a new conversation starts in: the one the web workspace and the server start it in. */
export const NEW_CONVERSATION_WEB_SEARCH = normalizeWebSearchMode(APP_DEFAULTS.defaultWebSearchMode);

/**
 * The composer tools a send carries. A conversation that does not exist yet starts from the default search position,
 * so the switch the person sees is exactly what the first request carries; a saved conversation keeps its own value,
 * and a change the person made (including turning search off) always wins.
 */
export function sendToolOptions(saved: boolean, changes: ComposerOptions | undefined): ComposerOptions | undefined {
  return saved ? changes : { webSearchMode: NEW_CONVERSATION_WEB_SEARCH, ...changes };
}

/** What the search switch shows: the person's change, else the saved conversation's value, else (new conversation) the default. */
export function shownWebSearchMode(saved: boolean, stored: ComposerOptions["webSearchMode"], changes: ComposerOptions | undefined) {
  return changes?.webSearchMode ?? stored ?? (saved ? undefined : NEW_CONVERSATION_WEB_SEARCH);
}
