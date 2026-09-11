export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";

import { apiSecurityResponse, consumeApiRateLimit } from "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
import {
    conversationLockedResponse,
    hasConversationUnlockGrant,
} from "@/lib/conversationLock";
import { getContinuationTimeline } from "@/lib/externalContinuationService";
import { prisma } from "@/lib/prisma";

/**
 * The read-only source half of a bridged conversation.
 *
 * Policy: docs/policy/external-conversation-continuation.md §8.
 *
 * ## Why this is a second endpoint and not a field on the conversation
 *
 * `GET /api/conversations/[id]` returns `Message` rows. Adding imported turns
 * to that array would put somebody else's assistant answers into the same
 * shape as Tomverse's own — the client would then be one `map` away from
 * rendering an imported reply as a Tomverse reply, which is the single failure
 * this feature is built to avoid. Two endpoints, two arrays, and the divider
 * between them is a fact about the data rather than a decoration.
 *
 * It is also cheaper in the ordinary case: every conversation that is not a
 * continuation answers 404 here and pays nothing on the hot path.
 *
 * ## What is deliberately not returned
 *
 * The snapshot digest, the import id, and any storage reference. The screen
 * needs the provider, when it was imported, the transcript, and the counts
 * behind the truncation notice. A digest identifies a snapshot; it is not an
 * access credential and it has no reason to leave the server.
 */
export async function GET(
    req: Request,
    context: RouteContext<"/api/conversations/[conversationId]/continuation">
) {
    try {
        const session = await getServerSession(authOptions);
        const userId = session?.user?.id;
        if (!userId) {
            return NextResponse.json(
                { error: "Authentication required." },
                { status: 401 }
            );
        }
        await consumeApiRateLimit(req, userId, "conversation-continuation-read", {
            minute: 120,
            day: 4000,
        });

        const { conversationId } = await context.params;

        // The native conversation's own lock, checked before anything about
        // the bridge is read. A locked Tomverse conversation answers 423 here
        // exactly as it does at every other conversation route -- the source
        // being unlocked separately does not open the conversation that
        // continues it.
        const conversation = await prisma.conversation.findFirst({
            where: { id: conversationId, userId },
            select: { id: true, password: true },
        });
        if (!conversation) {
            return NextResponse.json({ error: "Not found." }, { status: 404 });
        }
        if (
            !hasConversationUnlockGrant(
                req,
                userId,
                conversation.id,
                conversation.password
            )
        ) {
            return conversationLockedResponse();
        }

        const url = new URL(req.url);
        const offsetParam = url.searchParams.get("offset");
        const offsetRaw = Number(offsetParam);
        const limitRaw = Number(url.searchParams.get("limit"));
        // `offset=end` asks for the last page. The timeline is now drawn
        // inside the conversation, so the turns immediately before the
        // divider are the ones that have to load first -- and their offset
        // depends on a total only the server knows.
        const wantsEnd = offsetParam === "end";
        const timeline = await getContinuationTimeline(userId, conversationId, {
            request: req,
            offset:
                wantsEnd
                    ? undefined
                    : Number.isSafeInteger(offsetRaw) && offsetRaw >= 0
                      ? offsetRaw
                      : 0,
            fromEnd: wantsEnd,
            limit: Number.isSafeInteger(limitRaw) ? limitRaw : undefined,
        });
        // An ordinary conversation is not an error state, but it has no
        // continuation to describe. 404 rather than a null body so a client
        // cannot render "no source" chrome around a conversation that never
        // had one.
        if (!timeline) {
            return NextResponse.json({ error: "Not found." }, { status: 404 });
        }

        return NextResponse.json(timeline, {
            headers: { "Cache-Control": "no-store" },
        });
    } catch (error) {
        const securityResponse = apiSecurityResponse(error);
        if (securityResponse) return securityResponse;
        console.error("continuation timeline read failed", error);
        return NextResponse.json({ error: "서버 오류" }, { status: 500 });
    }
}
