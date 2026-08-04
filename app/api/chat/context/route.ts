import { randomUUID } from "node:crypto";
import { getServerSession } from "next-auth/next";
import { z } from "zod";
import {
    apiSecurityResponse,
    consumeApiRateLimit,
    readLimitedJson,
} from "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
import { issueChatContextBundle } from "@/lib/chatMemoryContext";
import {
    chatErrorResponse,
    getChatSigningSecret,
    identifyChatCaller,
} from "@/lib/chatSecurity";
import { prisma } from "@/lib/prisma";

/**
 * Context preparation for a single-model chat turn (§10).
 *
 * docs/policy/external-conversation-import-and-memory.md §10.
 *
 * §10 requires every authenticated chat that carries memory to present a
 * signed bundle, comparison and single-model alike. Comparison already had a
 * preflight to hang one on; a single-model turn did not, so this is it.
 *
 * Deliberately **not** the comparison preflight with a smaller `modelIds`.
 * That route reserves concurrency slots inside a transaction and hands back an
 * admission token, and a single-model turn must not take a slot here — it
 * takes one when it actually runs. Sharing the route would mean a branch
 * inside admission on how many models were asked for, which is exactly the
 * kind of entanglement that makes a concurrency contract impossible to reason
 * about. This route reserves nothing, charges nothing and admits nothing: it
 * reads the account's memory and signs a description of what it found.
 *
 * A `null` token is a normal answer, not a failure. It means this turn carries
 * no memory — the flag is off, the account opted out, or nothing matched — and
 * the chat request will reach the same conclusion and proceed without one.
 */

const contextSchema = z
    .object({
        conversationId: z.string().min(1).max(64).optional(),
        modelIds: z.array(z.string().min(1).max(100)).min(1).max(8),
        prompt: z.string().max(50_000),
    })
    .strict();

export async function POST(request: Request) {
    const traceId = randomUUID();
    try {
        const session = await getServerSession(authOptions);
        if (!session?.user?.id) {
            // Guests have no account memory, so there is nothing to prepare.
            // A 401 rather than an empty bundle: a client asking for one is
            // asking about an account, and pretending to answer would hide a
            // session that silently expired.
            return Response.json(
                { error: "Unauthorized", code: "UNAUTHORIZED", traceId },
                { status: 401, headers: { "X-Request-ID": traceId } }
            );
        }
        await consumeApiRateLimit(
            request,
            session.user.id,
            "chat-context-bundle",
            { minute: 60, day: 5_000 }
        );
        const payload = await readLimitedJson(request, 64 * 1024, contextSchema);

        // Ownership before anything is read from the conversation. A bundle is
        // bound to a conversation id, and issuing one for somebody else's
        // conversation would be signing a statement about an account this
        // caller does not hold.
        const conversationId =
            payload.conversationId && payload.conversationId !== "private-chat"
                ? payload.conversationId
                : null;
        if (conversationId) {
            const owned = await prisma.conversation.findFirst({
                where: { id: conversationId, userId: session.user.id },
                select: { id: true },
            });
            if (!owned) {
                return Response.json(
                    {
                        error: "Conversation access denied.",
                        code: "CONVERSATION_FORBIDDEN",
                        traceId,
                    },
                    { status: 403, headers: { "X-Request-ID": traceId } }
                );
            }
        }

        const access = identifyChatCaller(request, session.user.id);
        const bundle = await issueChatContextBundle({
            userId: session.user.id,
            subjectKey: access.subjectKey,
            conversationId,
            modelIds: payload.modelIds,
            query: payload.prompt,
            secret: getChatSigningSecret(),
        });

        return Response.json(
            {
                contextBundle: bundle.token,
                expiresAt: bundle.expiresAt,
                // Counts only, never statements: the composer shows "3
                // memories in use", and the content stays server-side (§16).
                memoryItemCount: bundle.factualCount + bundle.styleCount,
                memoryTokens: bundle.memoryTokens,
            },
            {
                headers: {
                    "Cache-Control": "no-store",
                    "X-Request-ID": traceId,
                },
            }
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
                event: "chat_context_bundle_failed",
                traceId,
                timestamp: new Date().toISOString(),
            })
        );
        return Response.json(
            {
                error: "The memory context could not be prepared.",
                code: "CONTEXT_BUNDLE_FAILED",
                traceId,
            },
            { status: 500, headers: { "X-Request-ID": traceId } }
        );
    }
}
