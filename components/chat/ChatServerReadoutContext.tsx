"use client";

import { createContext, useContext, type ReactNode } from "react";

/**
 * Whether this request offers the server voice for "Read aloud"
 * (docs/policy/voice-input.md §6.4).
 *
 * Resolved by the server (`readoutRefusal` in lib/chatReadoutAccess.ts) and
 * handed down as context, like `ChatAudioAttachmentProvider`: `process.env` in
 * a Client Component is fixed at build time, so a client-side copy would keep
 * calling the provider after an operator pulled the kill switch. Absent -- a
 * shared page, any surface outside the Chat workspace -- it is off and "Read
 * aloud" uses the browser's own voice.
 */
const ChatServerReadoutContext = createContext(false);

export function ChatServerReadoutProvider({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  return <ChatServerReadoutContext.Provider value={enabled}>{children}</ChatServerReadoutContext.Provider>;
}

export const useChatServerReadoutEnabled = () => useContext(ChatServerReadoutContext);
