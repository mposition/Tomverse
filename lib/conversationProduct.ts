/**
 * Which Tomverse product a conversation belongs to.
 *
 * Product boundary decision record v1.2, decision 2.
 *
 * ## Why this is not `kind`
 *
 * The delivery plan §5 is explicit -- "Do not reuse Conversation.kind as
 * product identity" -- and the reason is that `kind` is not a UI distinction.
 * `lib/conversationKindGuard.ts` owns it as a server authorization boundary:
 * the chat, comparison, share, export and title endpoints refuse an image
 * conversation, and the image endpoints refuse a chat one. Its comment says
 * what that costs to get wrong -- "UI non-exposure is not a security boundary
 * -- every server endpoint checks."
 *
 * So the two axes are orthogonal and neither substitutes for the other:
 *
 *   kind        the execution and permission modality -- chat or image;
 *   productKey  the product task the user is performing.
 *
 * ## Why `code` is not here
 *
 * The brand axis has four products. This allowlist has three. Admitting
 * `code` before Tomverse Code writes a single Conversation would make a row
 * with no execution surface a legal value -- a conversation nothing can open,
 * stored as if it were fine. `code` joins the list on the day Code starts
 * writing conversations, not before.
 *
 * ## Why there is no default
 *
 * The repository already wrote this decision down, in
 * 20260814170000_attempt_cost_accrual:
 *
 *   The default goes with the NOT NULL. A column that is nullable but defaults
 *   to 0 would answer "unknown" with "zero" for every writer that omits it,
 *   which is the exact substitution the nullability exists to prevent.
 *
 * A `review` default would make a writer that forgot `productKey` look like a
 * writer that meant Review. NULL during the transition means "not decided
 * yet", and that is precisely the backfill's work list.
 */

/**
 * The values `Conversation.productKey` may hold in v1.
 *
 * Compared against the database CHECK by `npm run check:enum-constraints`.
 */
export const CONVERSATION_PRODUCT_KEYS = ["chat", "review", "studio"] as const;

export type ConversationProductKey = (typeof CONVERSATION_PRODUCT_KEYS)[number];

export const isConversationProductKey = (
  value: unknown
): value is ConversationProductKey =>
  typeof value === "string" &&
  (CONVERSATION_PRODUCT_KEYS as readonly string[]).includes(value);

/**
 * Named constants for the server-side call sites.
 *
 * A product-specific endpoint decides its product from a module constant, not
 * from the request. Naming them here rather than writing the literal at each
 * call site means a reader of `createConversation(tx, { productKey: ... })`
 * lands on this file's reasoning, and a grep for the constant finds every
 * place a product is asserted.
 */
export const CHAT_PRODUCT_KEY: ConversationProductKey = "chat";
export const REVIEW_PRODUCT_KEY: ConversationProductKey = "review";
export const STUDIO_PRODUCT_KEY: ConversationProductKey = "studio";

/**
 * The modality each product runs in.
 *
 * Image generation is Studio; Chat and Review are both `kind: "chat"`. Held
 * here as well as in the CHECK so the application can refuse the combination
 * before the database has to, and so a drift between the two is visible in a
 * diff rather than at 3am in a failed write.
 */
export const PRODUCT_MODALITY: Readonly<
  Record<ConversationProductKey, "chat" | "image">
> = {
  chat: "chat",
  review: "chat",
  studio: "image",
};

/**
 * Auto is a Chat-only feature.
 *
 * Written as one allowed product rather than a list of forbidden ones. v1.1
 * of the decision record forbade `review + auto` and left `studio + auto`
 * passing; a rule shaped as "which product may" does not grow a hole every
 * time a product is added.
 */
export const AUTO_SELECTION_PRODUCT: ConversationProductKey = "chat";

export const productAllowsAutoSelection = (
  productKey: ConversationProductKey
): boolean => productKey === AUTO_SELECTION_PRODUCT;

/**
 * Whether a product/modality/selection-mode triple is one the database will
 * accept. `null` productKey is accepted throughout the transition -- see the
 * migration for why NOT VALID constraints cannot themselves catch a writer
 * that omitted the column.
 */
export const conversationProductViolation = (row: {
  productKey: ConversationProductKey | null;
  kind: string;
  selectionMode: string;
}): "unknown_product" | "product_modality" | "auto_not_chat" | null => {
  if (row.productKey === null) return null;
  if (!isConversationProductKey(row.productKey)) return "unknown_product";
  if (PRODUCT_MODALITY[row.productKey] !== row.kind) return "product_modality";
  if (row.selectionMode === "auto" && !productAllowsAutoSelection(row.productKey)) {
    return "auto_not_chat";
  }
  return null;
};
