/**
 * Which URL a conversation belongs at, once `/chat` changes meaning.
 *
 * Stored-product routing: docs/ui-contracts/chat-product-switcher.md. The product cutover is now wired:
 * `/chat` is Tomverse Chat and `/review` is Tomverse Review. A stored row still
 * decides where a conversation belongs; the URL never rewrites productKey.
 *
 * ## The problem it is for
 *
 * `/chat` used to be the Review workspace, and every Review deep link and
 * bookmark pointed at it. Now that `/chat` is Tomverse Chat, those links
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
 * It does not carry a surface fallback. A conversation with no stored product is not routed on a
 * guess; the caller reports it, which is what `strict` read mode is for.
 *
 * `resolveLegacyChatDeepLink` remains the pure stored-product decision used by
 * compatibility links. `/chat/workspace` remains an inbound alias only.
 */

import {
  isConversationProductKey,
  type ConversationProductKey,
} from "@/lib/conversationProduct";

/** The path each product's workspace lives at once the cutover happens. */
export const PRODUCT_SURFACE_PATH: Readonly<
  Record<ConversationProductKey, string>
> = {
  chat: "/chat",
  review: "/review",
  studio: "/studio",
};

/**
 * The historical Review path before the cutover.
 *
 * Held as its own constant rather than reusing `PRODUCT_SURFACE_PATH.review`,
 * Kept for compatibility-resolution tests and old bookmarks. Runtime Review
 * navigation uses {@link REVIEW_WORKSPACE_PATH}.
 */
export const LEGACY_REVIEW_PATH = "/chat";

/** Canonical Tomverse Chat entry. Availability is still enforced server-side. */
export const CHAT_WORKSPACE_PATH = PRODUCT_SURFACE_PATH.chat;

/** Inbound compatibility alias for links issued before `/chat` became Chat. */
export const CHAT_WORKSPACE_COMPATIBILITY_PATH = "/chat/workspace";

/** Canonical Tomverse Review entry. */
export const REVIEW_WORKSPACE_PATH = PRODUCT_SURFACE_PATH.review;

/**
 * Canonical workspace for a server-supplied product value.
 *
 * Public snapshots written before product identity was exposed have no value,
 * and an unrecognised value must not become Chat by guess. Review is the
 * historical, least-surprising fallback for those content-free links.
 */
export const productSurfacePathOrReview = (productKey: unknown): string =>
  isConversationProductKey(productKey)
    ? PRODUCT_SURFACE_PATH[productKey]
    : REVIEW_WORKSPACE_PATH;

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
