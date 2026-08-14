import { randomUUID } from "node:crypto";
import { getServerSession } from "next-auth/next";
import { z } from "zod";
import {
    apiSecurityResponse,
    consumeApiRateLimit,
    readLimitedJson,
} from "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
import { chatErrorResponse } from "@/lib/chatSecurity";
import { buildChatTurnContext } from "@/lib/chatTurnContext";
import { issueChatContextBundle } from "@/lib/chatContextBundleService";
import { getUserBillingPlan } from "@/lib/billingEntitlements";
import {
    conversationLockedResponse,
    hasConversationUnlockGrant,
} from "@/lib/conversationLock";
import {
    conversationKindNotSupportedResponse,
    isChatConversationKind,
} from "@/lib/conversationKindGuard";
import {
    databaseErrorMetadata,
    isRetryableDatabaseError,
} from "@/lib/databaseError";
import { prisma } from "@/lib/prisma";

/**
 * Context preparation for a single-model chat request (policy §10).
 *
 * A comparison already has a preparation step — `/api/chat/preflight` — and it
 * issues the bundle alongside its admission token. A single-model send has
 * never had one, because it needed nothing prepared: it acquires its own
 * concurrency slot and prices itself. Memory changes that. §10 requires the
 * context to be priced and signed before the request that sends it, for every
 * authenticated chat, and this is that step for the one shape that lacked it.
 *
 * It is deliberately NOT the preflight route with the model minimum relaxed.
 * Preflight reserves a concurrency slot as a whole; borrowing it here would
 * quietly move single-model admission onto the comparison path and change
 * behaviour that has nothing to do with memory. This route reserves nothing,
 * charges nothing and admits nothing — it answers "what context does this
 * request have, and what is its signed identity".
 *
 * A caller with no memory to inject (a guest, a disabled flag, an account
 * that turned memory off) gets `contextBundle: null` rather than an error.
 * That is not a failure state: it is what almost every request looks like
 * until §12.4's procedure has been completed, and the chat route runs without
 * memory exactly as it does today.
 */

const contextSchema = z
    .object({
        conversationId: z.string().min(1).max(64).nullable().optional(),
        modelIds: z.array(z.string().min(1).max(100)).min(1).max(3),
        prompt: z.string().max(50_000),
    })
    .strict();

const traceIdFor = (request: Request) => {
    const supplied = request.headers.get("X-Client-Request-ID")?.trim();
    const parsed = z.string().uuid().safeParse(supplied);
    return parsed.success ? parsed.data : randomUUID();
};

export async function POST(request: Request) {
    const traceId = traceIdFor(request);
    try {
        const session = await getServerSession(authOptions);
        const userId = session?.user?.id ?? null;

        await consumeApiRateLimit(
            request,
            userId ?? "guest",
            "chat-context-preparation",
            { minute: 60, day: 2_000 }
        );
        const payload = await readLimitedJson(request, 64 * 1024, contextSchema);

        const headers = new Headers({
            "Cache-Control": "no-store",
            "X-Request-ID": traceId,
        });

        // A guest has no account memory. Answered here rather than by the
        // builder alone so the route never touches the database for them.
        if (!userId) {
            return Response.json(
                { ok: true, contextBundle: null, memoryUsedCount: 0 },
                { headers }
            );
        }

        // "private-chat" is the client's name for a conversation that does not
        // exist on the server yet, so there is nothing to own and nothing to
        // unlock — but the bundle still binds `null`, and the chat request
        // must present the same.
        const conversationId =
            payload.conversationId && payload.conversationId !== "private-chat"
                ? payload.conversationId
                : null;

        // §8.1 invariant 1 and §10: both are read from the row rather than
        // defaulted, because the chat route reads them and a bundle priced
        // under different values than the send is stale on arrival — for
        // every message, not occasionally.
        let conversationMemoryMode: string | null = null;
        let profileVersionId: string | null = null;
        if (conversationId) {
            const conversation = await prisma.conversation.findUnique({
                where: { id: conversationId },
                select: {
                    userId: true,
                    password: true,
                    kind: true,
                    memoryMode: true,
                    assistantProfileVersionId: true,
                },
            });
            if (!conversation || conversation.userId !== userId) {
                return Response.json(
                    {
                        error: "Conversation access denied.",
                        code: "CONVERSATION_FORBIDDEN",
                        traceId,
                    },
                    { status: 403, headers }
                );
            }
            if (
                !hasConversationUnlockGrant(
                    request,
                    userId,
                    conversationId,
                    conversation.password
                )
            ) {
                return conversationLockedResponse();
            }
            if (!isChatConversationKind(conversation.kind)) {
                return conversationKindNotSupportedResponse();
            }
            conversationMemoryMode = conversation.memoryMode;
            profileVersionId = conversation.assistantProfileVersionId;
        }

        const context = await buildChatTurnContext({
            userId,
            query: payload.prompt,
            conversationMode: conversationMemoryMode,
            profileVersionId,
            plan: (await getUserBillingPlan(userId))?.tier ?? null,
        });

        // Nothing to bind: issuing a bundle for an empty context would make
        // the chat route verify a snapshot that says "no memory" and then
        // build one that also says "no memory" — the same answer, at the cost
        // of a nonce row per request. The absent bundle is the honest signal.
        //
        // Release C narrows what "empty" means. A turn with no memory can
        // still carry a profile's instructions and its retrieved knowledge,
        // and those are priced input tokens: skipping the bundle for one of
        // them would send a block nothing reserved against.
        if (!context.memory.decision.allowed && context.profileTokens === 0) {
            return Response.json(
                {
                    ok: true,
                    contextBundle: null,
                    memoryUsedCount: 0,
                    // Content-free, and useful: the client shows nothing
                    // either way, but the reason is what §22 counts.
                    reason: context.memory.decision.reason,
                },
                { headers }
            );
        }

        const bundle = issueChatContextBundle({
            subjectKey: userId,
            conversationId,
            modelIds: Array.from(new Set(payload.modelIds)),
            context,
        });

        return Response.json(
            {
                ok: true,
                contextBundle: bundle.token,
                contextBundleExpiresAt: bundle.expiresAt,
                // Server-computed (§13.4). The client never counts this
                // itself, and never sends a count back.
                memoryUsedCount: bundle.memoryUsedCount,
            },
            { headers }
        );
    } catch (error) {
        const securityResponse = apiSecurityResponse(error);
        if (securityResponse) {
            securityResponse.headers.set("X-Request-ID", traceId);
            return securityResponse;
        }
        const accessResponse = chatErrorResponse(error);
        if (accessResponse) {
            accessResponse.headers.set("X-Request-ID", traceId);
            return accessResponse;
        }
        console.error(
            JSON.stringify({
                event: "chat_context_preparation_failed",
                traceId,
                ...databaseErrorMetadata(error),
                timestamp: new Date().toISOString(),
            })
        );
        if (isRetryableDatabaseError(error)) {
            return Response.json(
                {
                    error: "Chat context preparation is temporarily unavailable.",
                    code: "CHAT_CONTEXT_TEMPORARILY_UNAVAILABLE",
                    traceId,
                },
                {
                    status: 503,
                    headers: {
                        "Cache-Control": "no-store",
                        "Retry-After": "1",
                        "X-Request-ID": traceId,
                    },
                }
            );
        }
        return Response.json(
            {
                error: "Chat context could not be prepared.",
                code: "CHAT_CONTEXT_PREPARATION_FAILED",
                traceId,
            },
            { status: 500, headers: { "X-Request-ID": traceId } }
        );
    }
}
