/**
 * Which URL a conversation belongs at, once `/chat` changes meaning.
 *
 * Product boundary decision record v1.2 §8. Written now and wired later, on
 * purpose: the rule needs `Conversation.productKey` to be settled before it
 * can be applied, and applying it early would move users on a value that is
 * still NULL for every row.
 *
 * ## The problem it is for
 *
 * `/chat` is the Review workspace today, and every Review deep link and
 * bookmark points at it. The day `/chat` becomes Tomverse Chat, those links
 * land on the wrong product. The fix is not a blanket redirect -- some `/chat`
 * links will genuinely be Chat by then -- it is to read the stored product and
 * send each conversation where it belongs.
 *
 * That is one more reason productKey has to be settled before the URL is: a
 * redirect decided from a NULL column would move Review conversations to Chat
 * or leave them behind, and there is nothing else on the row to appeal to.
 *
 * ## What it deliberately does not do
 *
 * It does not decide *when* `/chat` changes meaning, and it does not carry a
 * surface fallback. A conversation with no stored product is not routed on a
 * guess; the caller reports it, which is what `strict` read mode is for.
 *
 * Pure, and unwired: nothing calls this in production yet.
 */

import type { ConversationProductKey } from "@/lib/conversationProduct";

/** The path each product's workspace lives at once the cutover happens. */
export const PRODUCT_SURFACE_PATH: Readonly<
  Record<ConversationProductKey, string>
> = {
  chat: "/chat",
  review: "/review",
  studio: "/studio",
};

/**
 * `/chat` before the cutover: the Review workspace, unchanged.
 *
 * Held as its own constant rather than reusing `PRODUCT_SURFACE_PATH.review`,
 * because they mean different things -- this one is a fact about today, that
 * one is a decision about afterwards -- and they stop being equal on the day
 * of the cutover.
 */
export const LEGACY_REVIEW_PATH = "/chat";

export type DeepLinkResolution =
  | { action: "stay"; path: string }
  | { action: "move"; path: string }
  /** No stored product: not routed on a guess. See `strict` read mode. */
  | { action: "report"; path: null };

/**
 * Where a legacy `/chat?...` deep link should land after the cutover.
 *
 * The query is preserved by the caller: a deep link's parameters are the part
 * the user actually bookmarked, and dropping them would move somebody to a
 * workspace with none of the state they linked to.
 */
export const resolveLegacyChatDeepLink = (
  productKey: string | null
): DeepLinkResolution => {
  if (productKey === null) return { action: "report", path: null };
  if (!(productKey in PRODUCT_SURFACE_PATH)) return { action: "report", path: null };

  const path = PRODUCT_SURFACE_PATH[productKey as ConversationProductKey];
  return path === LEGACY_REVIEW_PATH
    ? { action: "stay", path }
    : { action: "move", path };
};

/**
 * The product label shown for a conversation, whatever URL it is open at.
 *
 * §8's open item: an image conversation is recorded as Studio the moment the
 * backfill runs, and showing it under Review chrome would put the user and the
 * data back to naming different products -- the state this whole decision
 * record exists to remove. The URL can follow later; the label is correct now.
 */
export const PRODUCT_LABEL: Readonly<Record<ConversationProductKey, string>> = {
  chat: "Tomverse Chat",
  review: "Tomverse Review",
  studio: "Tomverse Studio",
};

/**
 * The label for a conversation, from its stored product and, failing that, its
 * modality.
 *
 * The modality fallback is narrow and one-directional: `kind = "image"` can
 * only ever be Studio (`Conversation_product_modality_check` enforces exactly
 * that), so an image conversation is labelled Studio even before the backfill
 * gives it a productKey. `kind = "chat"` says nothing about Chat versus
 * Review, so it falls back to Review -- which is what the transition read mode
 * says a NULL product means anyway.
 */
export const conversationProductLabel = ({
  productKey,
  kind,
}: {
  productKey: string | null;
  kind: string;
}): string => {
  if (productKey !== null && productKey in PRODUCT_LABEL) {
    return PRODUCT_LABEL[productKey as ConversationProductKey];
  }
  return kind === "image" ? PRODUCT_LABEL.studio : PRODUCT_LABEL.review;
};
