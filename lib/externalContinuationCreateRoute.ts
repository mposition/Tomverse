import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { z } from "zod";

import {
    apiSecurityResponse,
    ApiSecurityError,
    consumeApiRateLimit,
    readLimitedJson,
} from "@/lib/apiSecurity";
import {
    assertExternalContinuationEnabled,
    ExternalContinuationDisabledError,
} from "@/lib/appSettings";
import { authOptions } from "@/lib/auth";
import { autoAvailabilityFor } from "@/lib/autoAvailability";
import { chatSurfaceAvailable } from "@/lib/autoProductBoundary";
import { lockErrorResponse } from "@/lib/conversationLock";
import {
    createExternalContinuation,
    type ContinuationProductKey,
} from "@/lib/externalContinuationService";

/**
 * The one create path both continuation endpoints share.
 *
 * Policy: docs/policy/external-conversation-continuation.md §3.1, §8.1.
 *
 * Each endpoint answers two server-side questions -- which snapshot, and which
 * product -- and everything else (auth, flag, rate limit, idempotency key,
 * lock, error codes) is identical, so it lives here once.
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

export type ContinuationTarget = {
    externalConversationId: string;
    productKey: ContinuationProductKey;
};

/**
 * Chat when this account may start a Chat, otherwise Review.
 *
 * The same surface-entry question `POST /api/products/chat/conversations`
 * asks. An account outside the Auto rollout would otherwise get a manual Chat
 * with none of the product's promise; Review is the screen it already has. An
 * unreadable availability reads as not offered, as `ChatWorkspaceShell` does.
 */
export const defaultContinuationProduct = async (
    userId: string
): Promise<ContinuationProductKey> =>
    (await autoAvailabilityFor(userId).then(chatSurfaceAvailable).catch(() => false))
        ? "chat"
        : "review";

export async function respondToContinuationCreate(
    req: Request,
    resolveTarget: (userId: string) => Promise<ContinuationTarget>
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
        const target = await resolveTarget(session.user.id);
        const result = await createExternalContinuation({
            userId: session.user.id,
            externalConversationId: target.externalConversationId,
            idempotencyKey: payload.idempotencyKey,
            request: req,
            productKey: target.productKey,
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

/** One 404 for "not yours", "no bridge" and "source deleted" (§10). */
export const continuationSourceNotFound = () =>
    new ApiSecurityError(404, "NOT_FOUND", "Conversation not found.");
