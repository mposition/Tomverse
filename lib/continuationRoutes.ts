/**
 * Where a conversation continued from an imported chat is opened.
 *
 * Policy: docs/policy/external-conversation-continuation.md §8.
 *
 * ## Why this is its own path and not `/chat`
 *
 * `/chat` and `/review` both render the Tomverse Review workspace
 * (`lib/productSurfaceRoutes.ts` says so, and says why: the cutover to
 * Tomverse Chat waits on `productKey` reaching strict read mode).
 *
 * A continuation is `productKey = "review"`
 * (docs/policy/external-conversation-continuation.md §3.1), so the product is
 * not what puts it here. The *screen* is: the Review workspace has no idea an
 * imported transcript exists -- no provenance section, no tombstone, no
 * snapshot lock -- and teaching it would mean rewiring a six-thousand-line
 * client for a feature that is off by default.
 *
 * So this is additive: no existing route changes meaning, the Review workspace
 * is not rewired, and when it can hold an imported transcript this constant is
 * the single place that moves.
 *
 * `PRODUCT_SURFACE_PATH.chat` is deliberately *not* reused. That constant is a
 * decision about where Chat will live after the cutover; this one is a fact
 * about where a continuation opens today. They are equal at neither end, and
 * writing one in terms of the other would make the cutover silently move these
 * conversations.
 */

export const CONTINUATION_SURFACE_PATH = "/continuations";

export const continuationPath = (conversationId: string): string =>
    `${CONTINUATION_SURFACE_PATH}/${encodeURIComponent(conversationId)}`;

/**
 * Which surface a conversation opens at.
 *
 * `"workspace"` is the Review workspace every conversation has always opened
 * in; `"continuation"` is `/continuations/[id]`.
 *
 * Server-decided, from a row rather than from a URL or a request body. That is
 * the whole point of it existing: a continuation is an ordinary `Conversation`
 * to the sidebar, so without a field on the list the sidebar opened it in the
 * Review workspace -- where the imported half and its provenance do not exist.
 * The conversation looked correct the moment it was created and wrong the next
 * time it was opened, which is the worst shape a defect can have.
 *
 * A boolean rather than a productKey: `productKey` is the product a
 * conversation belongs to and `PRODUCT_SURFACE_PATH` is where each product
 * will live after the cutover. Neither answers "where does *this* row open
 * today", and deriving the surface from the product would send every future
 * `chat` conversation here, continuation or not.
 */
export type ConversationSurface = "workspace" | "continuation";

export const conversationSurface = (input: {
    hasContinuationBridge: boolean;
}): ConversationSurface =>
    input.hasContinuationBridge ? "continuation" : "workspace";

/**
 * The path a surface opens at, or `null` for the workspace.
 *
 * Null rather than the workspace's own path because the two are not the same
 * kind of answer: the workspace selects a conversation in place, without
 * navigating, and handing it a path would make every sidebar click a page
 * load. A caller reads `null` as "do what you have always done".
 */
export const conversationSurfaceHref = (
    surface: ConversationSurface,
    conversationId: string
): string | null =>
    surface === "continuation" ? continuationPath(conversationId) : null;

/**
 * The query parameter a surface-crossing navigation carries a conversation in.
 *
 * Short-lived by construction: the workspace applies it to its selection and
 * then drops it from the address bar with `replaceState`, so it never becomes
 * a stale claim about which conversation is open. A pushed entry would be
 * worse than stale -- Back would replay a selection rather than returning to
 * the screen the user came from.
 */
export const CONVERSATION_HANDOFF_PARAM = "conversation";

/**
 * Where to send the browser when a selection belongs to another surface.
 *
 * Distinct from {@link conversationSurfaceHref}, which answers "does this
 * surface have a path of its own" and says `null` for the workspace precisely
 * because the workspace selects in place. Crossing is the case where in place
 * is not available: the screen holding the click is about to be unmounted, so
 * the conversation's id has to survive in the URL or it is lost.
 *
 * Losing it is what made this a bug rather than a rough edge. A click on an
 * ordinary conversation from `/continuations/[a]` used to land on a bare
 * `/chat`, which opens with no conversation named -- so the workspace fell
 * through to its session restore, found the continuation the user had *just
 * left* still recorded as the active one, selected it, and crossed straight
 * back to `/continuations/[a]`. The click looked like it did nothing.
 *
 * `workspacePath` is passed in rather than imported so this file does not
 * decide where the workspace lives: `/chat` and `/review` both render it and
 * which one a caller is on is the caller's own fact.
 */
export const conversationHandoffHref = (
    surface: ConversationSurface,
    conversationId: string,
    workspacePath: string
): string =>
    surface === "continuation"
        ? continuationPath(conversationId)
        : `${workspacePath}?${CONVERSATION_HANDOFF_PARAM}=${encodeURIComponent(
              conversationId
          )}`;
