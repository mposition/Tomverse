export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { z } from "zod";

import {
    apiSecurityResponse,
    consumeApiRateLimit,
    readLimitedJson,
} from "@/lib/apiSecurity";
import {
    assertExternalContinuationEnabled,
    ExternalContinuationDisabledError,
} from "@/lib/appSettings";
import { authOptions } from "@/lib/auth";
import { lockErrorResponse } from "@/lib/conversationLock";
import { createExternalContinuation } from "@/lib/externalContinuationService";

/**
 * Start a Tomverse conversation from one imported snapshot.
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

const createSchema = z
    .object({
        /**
         * The caller's own key for *this attempt*.
         *
         * Required rather than optional: a missing key would mean every
         * network retry of a click created another conversation, and the
         * server cannot tell a retry from a second deliberate fork by looking
         * at the request. A UUID from the browser is the smallest thing that
         * can distinguish them, and it is a key rather than an assertion —
         * the server still decides ownership, the lock and the product.
         */
        idempotencyKey: z.string().uuid(),
    })
    .strict();

export async function POST(
    req: Request,
    context: RouteContext<"/api/external-conversations/[conversationId]/continuations">
) {
    try {
        const session = await getServerSession(authOptions);
        if (!session?.user?.id) {
            return NextResponse.json(
                { error: "Authentication required." },
                { status: 401 }
            );
        }
        await assertExternalContinuationEnabled();
        await consumeApiRateLimit(
            req,
            session.user.id,
            "external-conversation-continuation-create",
            { minute: 10, day: 200 }
        );

        const payload = await readLimitedJson(req, 4 * 1024, createSchema);
        const params = await context.params;
        const result = await createExternalContinuation({
            userId: session.user.id,
            externalConversationId: params.conversationId,
            idempotencyKey: payload.idempotencyKey,
            request: req,
        });

        return NextResponse.json(result, {
            // 200 on a replay and 201 on the first creation. The body is
            // identical either way, so a client that ignores the distinction
            // still behaves correctly -- the code is for an operator reading
            // logs, not a second path for the browser.
            status: result.idempotentReplay ? 200 : 201,
            headers: { "Cache-Control": "no-store" },
        });
    } catch (error) {
        if (error instanceof ExternalContinuationDisabledError) {
            return NextResponse.json(
                {
                    error: error.message,
                    code: "EXTERNAL_CONTINUATION_DISABLED",
                },
                { status: 403 }
            );
        }
        const securityResponse = apiSecurityResponse(error);
        if (securityResponse) return securityResponse;
        // 423 CONVERSATION_LOCKED: a locked snapshot may be continued only by
        // somebody holding a valid external_conversation grant (§6).
        const lockError = lockErrorResponse(error);
        if (lockError) return lockError;
        console.error("external conversation continuation failed", error);
        return NextResponse.json({ error: "서버 오류" }, { status: 500 });
    }
}
