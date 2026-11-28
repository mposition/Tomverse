import "server-only";

import { READOUT_ENV, readoutRefusal } from "@/lib/chatReadoutAccess";
import { resolveProviderApiKey } from "@/lib/modelRegistryShared";

/**
 * The server read-aloud's key, bound to this process's environment.
 *
 * `CHAT_SERVER_READOUT_API_KEY`, falling back to the shared OpenAI key through
 * `resolveProviderApiKey` -- the shape voice input's key takes
 * (lib/voiceTranscriptionPort.ts), so a deployment can send speech to a
 * separate account without touching chat.
 */
export const readoutApiKey = (): string | null =>
  process.env[READOUT_ENV.apiKey]?.trim() || resolveProviderApiKey("openai") || null;

/** The one boolean the Chat page hands down (components/chat/ChatServerReadoutContext.tsx). */
export const chatServerReadoutOffered = (): boolean =>
  readoutRefusal({ env: process.env, hasProviderKey: Boolean(readoutApiKey()) }) === null;
