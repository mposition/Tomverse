import { consumeChatStreamCore, type createChatLocationSession } from "@tomverse/chat-core";

import type { MobileRequestInit } from "./authenticatedFetch";

export type NativeChatMessage = { role: "user" | "assistant"; content: string };
export type NativeChatLocationSession = ReturnType<typeof createChatLocationSession>;
export type NativeChatTransport = (path: string, init?: MobileRequestInit) => Promise<Response>;

export class NativeChatError extends Error {
  constructor(public readonly status: number, public readonly code: string) {
    super(code);
  }
}

export const sendNativeChat = async (input: {
  transport: NativeChatTransport;
  location: NativeChatLocationSession;
  identityKey: string;
  messages: NativeChatMessage[];
  webSearch: boolean;
  signal: AbortSignal;
  onText: (text: string) => void;
}) => {
  const fix = await input.location.readForTurn(input.identityKey);
  input.signal.throwIfAborted();
  const response = await input.transport("/api/mobile/chat", () => {
    input.signal.throwIfAborted();
    return {
      method: "POST", headers: { "Content-Type": "application/json" }, signal: input.signal,
    body: JSON.stringify({
      messages: input.messages,
      webSearchMode: input.webSearch ? "always" : "off",
      ...(fix && input.location.canShare(fix, input.identityKey) ? { currentLocation: fix } : {}),
    }),
    };
  });
  if (!response.ok) {
    const data = await response.json().catch(() => null) as { code?: unknown } | null;
    throw new NativeChatError(response.status, typeof data?.code === "string" ? data.code : "CHAT_FAILED");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new NativeChatError(502, "EMPTY_STREAM");
  try {
    const result = await consumeChatStreamCore({
      reader, decoder: new TextDecoder(),
      liveness: { noteKeepalive() {}, noteVisibleChunk() {} },
      onProgress: ({ displayText }) => input.onText(displayText),
    });
    if (result.serverStallCode) throw new NativeChatError(504, result.serverStallCode);
    if (!result.displayText.trim()) throw new NativeChatError(502, "EMPTY_RESPONSE");
    input.onText(result.displayText);
    return result.displayText;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
};
