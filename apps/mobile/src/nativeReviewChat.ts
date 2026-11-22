import { reviewInputKey, type ReviewChatSource } from "../../../lib/reviewToChat";
import type { ChatTransport } from "./chatTransport";

/** Revalidate through the authenticated native transport, never ambient cookies. */
export async function confirmNativeReviewSource(source: ReviewChatSource, transport: ChatTransport) {
  const setup = source.kind === "quick"
    ? await transport.quickSummaryPreview?.(source.conversationId)
    : await transport.reviewPreview?.(source.conversationId, source.mode, source.includeSynthesis);
  if (!setup?.available || !setup.source || reviewInputKey(setup) !== reviewInputKey(source.setup)) return false;
  const stored = "storedSummary" in setup ? setup.storedSummary : "storedReview" in setup ? setup.storedReview : undefined;
  if (!stored || ("guest" in stored && stored.guest) || ("persisted" in stored && stored.persisted === false)) return false;
  return JSON.stringify([stored.id, stored.reviewerModelId, stored.result, stored.responseMap]) ===
    JSON.stringify([source.review.id, source.review.reviewerModelId, source.review.result, source.review.responseMap]);
}
