export const dynamic = "force-dynamic";

import {
    defaultContinuationProduct,
    respondToContinuationCreate,
} from "@/lib/externalContinuationCreateRoute";

/**
 * Start a Tomverse conversation from one imported snapshot.
 *
 * Chat (Smart Adaptive) for an account Chat is offered to, otherwise Review
 * (owner decision 2026-10-25). The product is the server's decision; the
 * body carries only the idempotency key. Comparing models on the same
 * original is `POST /api/conversations/[id]/continuation/review`.
 *
 * Policy: docs/policy/external-conversation-continuation.md.
 *
 * ## Why this lives under the external resource
 *
 * The thing being acted on is the imported snapshot: the caller is saying
 * "continue *this*". Putting it under `/api/conversations` would have needed a
 * body field naming an external id, and an external id in a request body is
 * the client's claim about what it may read — the ownership check would then
 * be a rule somebody has to remember rather than the shape of the URL. Here
 * the path segment is resolved against `userId` by the service, and a
 * cross-account id is a 404 with no branch that could say otherwise.
 *
 * ## Why it fails closed
 *
 * `feature.externalConversationContinuationEnabled` is off by default and a
 * missing row reads as off (§7). With the flag off this endpoint refuses, so a
 * client that kept the button will not create a bridge; reading an existing
 * bridged conversation and sending ordinary messages in it stay open, because
 * a rollback must never take away work the user already did.
 */

export async function POST(
    req: Request,
    context: RouteContext<"/api/external-conversations/[conversationId]/continuations">
) {
    return respondToContinuationCreate(req, async (userId) => ({
        externalConversationId: (await context.params).conversationId,
        productKey: await defaultContinuationProduct(userId),
    }));
}
