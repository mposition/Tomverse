"use client";

import { createContext, useContext, type ReactNode } from "react";

/**
 * Whether this request offers recordings as chat attachments.
 *
 * Resolved by the server (`chatAudioAttachmentEnabled` in
 * `lib/chatAudioAttachment.ts`) and handed down as context, for the reason
 * every other switch is: `process.env` in a Client Component is fixed at build
 * time. Context rather than a prop so the value reaches the composer without
 * threading through both chat shells. Absent, it is off.
 */
const ChatAudioAttachmentContext = createContext(false);

export function ChatAudioAttachmentProvider({
    enabled,
    children,
}: {
    enabled: boolean;
    children: ReactNode;
}) {
    return (
        <ChatAudioAttachmentContext.Provider value={enabled}>
            {children}
        </ChatAudioAttachmentContext.Provider>
    );
}

export const useChatAudioAttachmentsEnabled = () =>
    useContext(ChatAudioAttachmentContext);
