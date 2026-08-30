/**
 * Where a conversation continued from an imported chat is opened.
 *
 * Policy: docs/policy/external-conversation-continuation.md §8.
 *
 * ## Why this is its own path and not `/chat`
 *
 * `/chat` and `/review` both render the Tomverse Review workspace
 * (`lib/productSurfaceRoutes.ts` says so, and says why: the cutover to
 * Tomverse Chat waits on `productKey` reaching strict read mode). A
 * continuation is `productKey = "chat"`, and the two honest options were to
 * open it in the Review shell -- a multi-model comparison workspace that has
 * no idea an imported transcript exists -- or to give it a surface of its own.
 *
 * The second is what this is. It is additive: no existing route changes
 * meaning, the Review workspace is not rewired, and when Tomverse Chat gets
 * its own surface this constant is the single place that moves.
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
