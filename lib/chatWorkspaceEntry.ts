import { conversationSurface, type ConversationSurface } from "@/lib/continuationRoutes";

export type ChatWorkspaceEntryDecision =
  | { action: "open" }
  | { action: "not_found" }
  | { action: "redirect"; surface: ConversationSurface };

/** The caller must read this row with both id and authenticated userId. */
export function decideChatWorkspaceEntry(input: {
  authenticated: boolean;
  requestedConversation: boolean;
  ownedConversation: { productKey: string | null; hasContinuationBridge: boolean } | null;
  offered: boolean;
}): ChatWorkspaceEntryDecision {
  if (!input.authenticated) return { action: "not_found" };
  if (input.requestedConversation) {
    if (!input.ownedConversation) return { action: "not_found" };
    const surface = conversationSurface(input.ownedConversation);
    return surface === "chat" ? { action: "open" } : { action: "redirect", surface };
  }
  return input.offered ? { action: "open" } : { action: "not_found" };
}

export const CHAT_SINGLE_MODEL_REQUIRED = "CHAT_SINGLE_MODEL_REQUIRED";
export const CHAT_PROFILE_SINGLE_MODEL_REQUIRED = "CHAT_PROFILE_SINGLE_MODEL_REQUIRED";

/** Only for a new, unbound draft; never apply to a saved conversation/profile. */
export function newWorkspaceDraftModels(input: {
  surface: ConversationSurface;
  models: readonly string[];
  fallbackModelId: string;
}): string[] {
  return input.surface === "chat"
    ? [input.models[0] ?? input.fallbackModelId]
    : [...input.models];
}

/** Validate the original choice, never silently shrink a profile or default. */
export function chatSingleModelRefusal(input: {
  productKey: string;
  selectedModels: readonly string[];
  fromProfile: boolean;
}): string | null {
  if (input.productKey !== "chat" || input.selectedModels.length === 1) return null;
  return input.fromProfile ? CHAT_PROFILE_SINGLE_MODEL_REQUIRED : CHAT_SINGLE_MODEL_REQUIRED;
}

/** A prepared Chat request cannot be handed to a different visible owner/model. */
export function chatPreparedSendIsCurrent(input: {
  identityKey: string | null;
  currentIdentityKey: string;
  conversationId: string | null;
  currentConversationId: string | null;
  selectionTicket: number;
  currentSelectionTicket: number;
  modelIds: readonly string[];
  currentModelIds: readonly string[];
  currentDisabledIds: readonly string[];
}): boolean {
  return Boolean(input.identityKey) && input.identityKey === input.currentIdentityKey &&
    input.selectionTicket === input.currentSelectionTicket &&
    input.conversationId === input.currentConversationId &&
    input.modelIds.length === 1 && input.currentModelIds.length === 1 &&
    input.modelIds[0] === input.currentModelIds[0] &&
    !input.currentDisabledIds.includes(input.modelIds[0]);
}

/** A newly edited draft is not the draft that an earlier Send consumed. */
export function chatDraftMatchesSubmission(input: {
  submittedText: string;
  submittedAttachmentIds: readonly string[];
  currentText: string;
  currentAttachmentIds: readonly string[];
}): boolean {
  return input.submittedText === input.currentText &&
    input.submittedAttachmentIds.length === input.currentAttachmentIds.length &&
    input.submittedAttachmentIds.every((id, index) => id === input.currentAttachmentIds[index]);
}
