"use client";

import { useMemo } from "react";
import {
  readGuestChatContentState,
  type ChatContentState,
} from "@/lib/chatContentState";
import { guestMessageKeysForConversation } from "@/lib/guestConversationStorage";

/**
 * The shells' synchronous answer to "does this guest conversation already have
 * a turn in it", read straight from localStorage on the render that first sees
 * the conversation id.
 *
 * A guest's `currentChatId` is a client-generated placeholder handed out to
 * every new chat, empty ones included, so its mere presence says nothing --
 * which is why the shells used to treat any guest conversation as empty until
 * a panel said otherwise, and flashed ChatWelcomeScreen over restored
 * transcripts. The transcripts themselves are the signal, and they are right
 * there in storage.
 *
 * Only a seed: it is consulted solely while no panel has reported yet
 * (see resolveChatContentState), so a later send never has to invalidate it.
 * Accounts have no equivalent -- their transcripts come over the network -- and
 * pass "unknown", which renders the panel loading states instead.
 */
export function useGuestChatContentSeed(
  isGuestMode: boolean,
  conversationId: string | null
): ChatContentState {
  return useMemo(() => {
    if (!isGuestMode || typeof window === "undefined") return "unknown";
    try {
      return readGuestChatContentState(
        conversationId,
        {
          keys: () => Object.keys(window.localStorage),
          getItem: (key) => window.localStorage.getItem(key),
        },
        guestMessageKeysForConversation
      );
    } catch {
      // Storage disabled (private mode, blocked cookies): the panels settle it.
      return "unknown";
    }
  }, [conversationId, isGuestMode]);
}
