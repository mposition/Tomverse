import type { Conversation, Message } from "@/components/chat/types";

export const PENDING_GUEST_IMPORT_KEY = "tomverse_pending_guest_import";
export const GUEST_IMPORT_SEEN_KEY = "tomverse_guest_import_prompted_v1";
export const GUEST_IMPORT_LOCAL_MARKER_KEY = "tomverse_guest_imported_ids";

const PENDING_GUEST_IMPORT_MAX_AGE_MS = 10 * 60 * 1000;

export type PendingGuestImportIntent = {
  intent: "current";
  conversationId: string;
  writtenAt: number;
};

export type GuestConversationSummary = {
  id: string;
  title: string;
  createdAt: string | null;
  messageCount: number;
  alreadyImported: boolean;
};

export type GuestImportPayloadMessage = {
  role: "user" | "assistant";
  content: string;
  status: "normal" | "error" | "cancelled";
  modelId: string | null;
  createdAt: string;
};

export type GuestImportPayload = {
  guestConversationId: string;
  title: string;
  selectedModels: string[];
  disabledPanels: string[];
  createdAt: string;
  messages: GuestImportPayloadMessage[];
};

export type GuestImportResult =
  | { success: true; conversationId: string; alreadyImported: boolean }
  | { success: false; error: string };

// A conversation is "empty" if no user message was ever sent in it (in any
// model panel). The welcome placeholder message (id "welcome") never
// counts, nor does having changed selectedModels/disabledPanels/title --
// those are draft-setup actions, not conversation content.
export function isGuestConversationEmpty(
  conversation: Pick<Conversation, "id" | "selectedModels" | "disabledPanels">
): boolean {
  if (typeof window === "undefined") return true;
  const modelIds = Array.from(
    new Set([...(conversation.selectedModels || []), ...(conversation.disabledPanels || [])])
  );
  for (const modelId of modelIds) {
    const raw = window.localStorage.getItem(`guest_messages_${conversation.id}_${modelId}`);
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.some((message: Message) => message.role === "user")) {
        return false;
      }
    } catch {
      continue;
    }
  }
  return true;
}

// Removes every per-model guest_messages_{conversationId}_{modelId} entry
// for a conversation, regardless of which models the conversation's
// current selectedModels/disabledPanels list -- a conversation may have
// used other models earlier before the panel selection changed, and this
// must not leave those orphaned.
export function removeGuestConversationStorage(conversationId: string): void {
  if (typeof window === "undefined") return;
  const prefix = `guest_messages_${conversationId}_`;
  const keysToRemove: string[] = [];
  for (let i = 0; i < window.localStorage.length; i++) {
    const key = window.localStorage.key(i);
    if (key && key.startsWith(prefix)) keysToRemove.push(key);
  }
  keysToRemove.forEach((key) => window.localStorage.removeItem(key));
}

const readGuestConversations = (): Conversation[] => {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem("guest_conversations");
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const readImportedIdCache = (): Set<string> => {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(GUEST_IMPORT_LOCAL_MARKER_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : []);
  } catch {
    return new Set();
  }
};

const markImportedLocally = (guestConversationId: string) => {
  if (typeof window === "undefined") return;
  const ids = readImportedIdCache();
  ids.add(guestConversationId);
  window.localStorage.setItem(GUEST_IMPORT_LOCAL_MARKER_KEY, JSON.stringify(Array.from(ids)));
};

export function writePendingGuestImportIntent(conversationId: string): void {
  if (typeof window === "undefined" || !conversationId) return;
  const payload: PendingGuestImportIntent = {
    intent: "current",
    conversationId,
    writtenAt: Date.now(),
  };
  window.localStorage.setItem(PENDING_GUEST_IMPORT_KEY, JSON.stringify(payload));
}

export function consumePendingGuestImportIntent(): PendingGuestImportIntent | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(PENDING_GUEST_IMPORT_KEY);
  if (!raw) return null;
  window.localStorage.removeItem(PENDING_GUEST_IMPORT_KEY);
  try {
    const parsed = JSON.parse(raw) as Partial<PendingGuestImportIntent>;
    if (
      parsed.intent !== "current" ||
      typeof parsed.conversationId !== "string" ||
      typeof parsed.writtenAt !== "number"
    ) {
      return null;
    }
    if (Date.now() - parsed.writtenAt > PENDING_GUEST_IMPORT_MAX_AGE_MS) return null;
    return parsed as PendingGuestImportIntent;
  } catch {
    return null;
  }
}

// Merges every per-model localStorage array for one guest conversation into
// a single ordered message list. A multi-model comparison stores the same
// user question independently under each model's own key (see ChatApp.tsx's
// handleSendPrompt), so user messages are deduped by id the same way the
// real-conversation fetch effect already does (ChatApp.tsx's seenUserIds).
export function buildGuestImportPayload(guestConversationId: string): GuestImportPayload | null {
  if (typeof window === "undefined") return null;
  const conversations = readGuestConversations();
  const conversation = conversations.find((c) => c.id === guestConversationId);
  if (!conversation) return null;

  const modelIds = Array.from(
    new Set([...(conversation.selectedModels || []), ...(conversation.disabledPanels || [])])
  );

  const seenUserIds = new Set<string>();
  const merged: GuestImportPayloadMessage[] = [];

  modelIds.forEach((modelId, panelIndex) => {
    const raw = window.localStorage.getItem(`guest_messages_${guestConversationId}_${modelId}`);
    if (!raw) return;
    let parsedMessages: Message[];
    try {
      parsedMessages = JSON.parse(raw);
    } catch {
      return;
    }
    if (!Array.isArray(parsedMessages)) return;

    parsedMessages.forEach((message, indexInPanel) => {
      if (message.id === "welcome") return;
      if (message.role === "user") {
        if (seenUserIds.has(message.id)) return;
        seenUserIds.add(message.id);
      }
      merged.push({
        role: message.role,
        content: message.content,
        status: message.status || "normal",
        modelId: message.role === "assistant" ? modelId : null,
        createdAt:
          message.createdAt ||
          // Legacy messages saved before createdAt existed: synthesize a
          // stable, monotonically increasing timestamp from position so
          // ordering survives even without a real chat-time timestamp.
          new Date(Date.parse(conversation.createdAt || new Date().toISOString()) + panelIndex * 1000 + indexInPanel).toISOString(),
      });
    });
  });

  merged.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));

  return {
    guestConversationId,
    title: conversation.title || "Guest chat",
    selectedModels: conversation.selectedModels && conversation.selectedModels.length > 0
      ? conversation.selectedModels
      : modelIds,
    disabledPanels: conversation.disabledPanels || [],
    createdAt: conversation.createdAt || new Date().toISOString(),
    messages: merged,
  };
}

export function listImportableGuestConversations(): GuestConversationSummary[] {
  if (typeof window === "undefined") return [];
  const importedIds = readImportedIdCache();
  return readGuestConversations()
    .map((conversation) => {
      const payload = buildGuestImportPayload(conversation.id);
      return {
        id: conversation.id,
        title: conversation.title || "Guest chat",
        createdAt: conversation.createdAt || null,
        messageCount: payload?.messages.length || 0,
        alreadyImported: importedIds.has(conversation.id),
      };
    })
    .filter((summary) => summary.messageCount > 0);
}

export async function importGuestConversation(
  payload: GuestImportPayload
): Promise<GuestImportResult> {
  try {
    const response = await fetch("/api/conversations/import-guest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      return { success: false, error: `HTTP ${response.status}` };
    }
    const data = await response.json();
    if (!data?.success || typeof data.conversationId !== "string") {
      return { success: false, error: "Malformed response" };
    }
    markImportedLocally(payload.guestConversationId);
    return {
      success: true,
      conversationId: data.conversationId,
      alreadyImported: Boolean(data.alreadyImported),
    };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : "Unknown error" };
  }
}
