import { reviewInputKey, type ReviewChatSelection, type ReviewChatSource } from "../../../lib/reviewToChat";
import type { ChatTransport } from "./chatTransport";

/** What a Review result offers to Chat: one reviewer's whole result or one of its items. */
export type NativeReviewChatOffer = { source: ReviewChatSource; selection?: ReviewChatSelection };

/** The owner's new-Chat draft as the parent holds it (memory first, storage fallback). */
export type NativeChatDraftSnapshot = { owner: string; generation: number; text: string; files: Array<{ uploadId: string; name: string }> };
export type NativeChatDraftApply = "applied" | "changed" | "tooLarge" | "unavailable";
export const NATIVE_CHAT_DRAFT_LIMIT = 40_000;

export const hasNativeChatDraft = (draft: NativeChatDraftSnapshot) => draft.text.length > 0 || draft.files.length > 0;
export const sameNativeChatDraft = (a: NativeChatDraftSnapshot | null, b: NativeChatDraftSnapshot | null) => Boolean(a && b &&
  a.owner === b.owner && a.generation === b.generation && a.text === b.text &&
  a.files.length === b.files.length && a.files.every((file, index) => file.uploadId === b.files[index]!.uploadId));

/** Appends after the user's text, whitespace-only text included; never truncates. */
export function appendNativeReviewChatDraft(existing: string, reference: string) {
  const next = existing ? `${existing}\n\n${reference}` : reference;
  return next.length <= NATIVE_CHAT_DRAFT_LIMIT ? next : null;
}

/** Revalidate through the authenticated native transport, never ambient cookies. */
export async function confirmNativeReviewSource(source: ReviewChatSource, transport: ChatTransport, selection?: ReviewChatSelection, signal?: AbortSignal) {
  const setup = source.kind === "quick"
    ? await transport.quickSummaryPreview?.(source.conversationId, signal)
    : await transport.reviewPreview?.(source.conversationId, source.mode, source.includeSynthesis, signal);
  signal?.throwIfAborted();
  if (!setup?.available || !setup.source || reviewInputKey(setup) !== reviewInputKey(source.setup)) return false;
  if (source.kind === "quick" && (setup as { cached?: boolean }).cached !== true) return false;
  const stored = "storedSummary" in setup ? setup.storedSummary : "storedReview" in setup ? setup.storedReview : undefined;
  if (!stored || ("guest" in stored && stored.guest) || ("persisted" in stored && stored.persisted === false)) return false;
  if (selection?.itemId && source.kind === "review") {
    // The server's item identity must still name the same reviewer, section and ordinal.
    const item = "reviewItems" in stored ? stored.reviewItems?.find(row => row.id === selection.itemId) : undefined;
    if (!item || item.reviewer !== source.reviewer || item.section !== selection.section || item.ordinal !== selection.ordinal) return false;
  }
  return JSON.stringify([stored.id, stored.reviewerModelId, stored.result, stored.responseMap]) ===
    JSON.stringify([source.review.id, source.review.reviewerModelId, source.review.result, source.review.responseMap]);
}
