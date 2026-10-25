export const dynamic = "force-dynamic";

import {
    continuationSourceNotFound,
    respondToContinuationCreate,
} from "@/lib/externalContinuationCreateRoute";
import { getContinuationBridge } from "@/lib/externalContinuationService";

/**
 * Continue the same imported original in Tomverse Review.
 *
 * Policy: docs/policy/external-conversation-continuation.md §8.1.
 *
 * The "Compare in Review" button on a Chat continuation. It creates a second,
 * deliberate fork (§3) -- a new Review conversation bridged to the same
 * snapshot -- and never rewrites the Chat conversation's `productKey`
 * (docs/ui-contracts/chat-product-switcher.md §1).
 *
 * The snapshot is read from this conversation's own bridge, scoped by
 * `userId`, so the client never names an external id on an account
 * conversation API. No bridge, somebody else's conversation and a deleted
 * source are one 404. The snapshot lock, flag, rate limit and idempotency key
 * are the same as the original create.
 */
export async function POST(
    req: Request,
    context: RouteContext<"/api/conversations/[conversationId]/continuation/review">
) {
    return respondToContinuationCreate(req, async (userId) => {
        const bridge = await getContinuationBridge(
            userId,
            (await context.params).conversationId
        );
        if (!bridge?.externalConversationId) throw continuationSourceNotFound();
        return {
            externalConversationId: bridge.externalConversationId,
            productKey: "review",
        };
    });
}
