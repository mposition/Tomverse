import { resolveChatRouteSession } from "@/lib/chatRouteSession";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { z } from "zod";

import { apiSecurityResponse, consumeApiRateLimit, readLimitedJson } from "@/lib/apiSecurity";
import {
    CHAT_ANSWER_RATING_REFUSAL_STATUS,
    chatAnswerRatingRefusal,
    chatAnswerRatingWriteSchema,
    publicChatAnswerRating,
    type PublicChatAnswerRating,
} from "@/lib/chatAnswerRatingCore";
import { conversationLockedResponse, hasConversationUnlockGrant } from "@/lib/conversationLock";
import { prisma } from "@/lib/prisma";

/**
 * Thumbs up or down on an assistant answer (lib/chatAnswerRatingCore.ts).
 *
 * Signed-in owners only, on their own unlocked conversations: another
 * account's answer reads as not found, and a locked conversation needs its
 * unlock grant like every other read or write of it. The model is copied from
 * the answer's own row, never taken from the request.
 */

const RATING_SELECT = { messageId: true, rating: true, reason: true } as const;

const conversationIdSchema = z.string().trim().min(1).max(191);

const ratingsOf = (rows: Array<{ messageId: string; rating: string; reason: string | null }>) =>
    rows.map(publicChatAnswerRating).filter((row): row is PublicChatAnswerRating => row !== null);

export async function GET(req: Request) {
    try {
        const routeAuth = await resolveChatRouteSession(req);
        if (routeAuth.response) return routeAuth.response;
        const userId = routeAuth.session?.user?.id;
        if (!userId) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
        await consumeApiRateLimit(req, userId, "answer-rating-read", { minute: 120, day: 10_000 });
        const parsed = conversationIdSchema.safeParse(new URL(req.url).searchParams.get("conversationId"));
        if (!parsed.success) return NextResponse.json({ error: "conversationId is required." }, { status: 400 });
        const conversation = await prisma.conversation.findFirst({
            where: { id: parsed.data, userId },
            select: { id: true, password: true, passwordVersion: true },
        });
        if (!conversation) return NextResponse.json({ error: "Conversation not found." }, { status: 404 });
        if (!hasConversationUnlockGrant(req, userId, conversation.id,
            conversation.password == null ? null : conversation.passwordVersion)) {
            return conversationLockedResponse();
        }
        const rows = await prisma.chatAnswerRating.findMany({
            where: { userId, conversationId: conversation.id },
            select: RATING_SELECT,
            take: 2_000,
        });
        return NextResponse.json({ ratings: ratingsOf(rows) });
    } catch (error) {
        const securityResponse = apiSecurityResponse(error);
        if (securityResponse) return securityResponse;
        console.error("Failed to read answer ratings:", error);
        return NextResponse.json({ error: "Failed to load ratings." }, { status: 500 });
    }
}

export async function PUT(req: Request) {
    try {
        const routeAuth = await resolveChatRouteSession(req);
        if (routeAuth.response) return routeAuth.response;
        const userId = routeAuth.session?.user?.id;
        if (!userId) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
        await consumeApiRateLimit(req, userId, "answer-rating-write", { minute: 60, day: 2_000 });
        const body = await readLimitedJson(req, 2 * 1024, chatAnswerRatingWriteSchema);
        const message = await prisma.message.findUnique({
            where: { id: body.messageId },
            select: {
                id: true,
                role: true,
                status: true,
                modelId: true,
                conversationId: true,
                conversation: { select: { userId: true, kind: true, password: true, passwordVersion: true } },
            },
        });
        const refusal = chatAnswerRatingRefusal({
            message,
            userId,
            unlocked: message !== null && hasConversationUnlockGrant(req, userId, message.conversationId,
                message.conversation.password == null ? null : message.conversation.passwordVersion),
        });
        if (refusal === "locked") return conversationLockedResponse();
        if (refusal || !message) {
            return NextResponse.json(
                { error: "This answer cannot be rated.", code: `ANSWER_RATING_${(refusal ?? "not_found").toUpperCase()}` },
                { status: CHAT_ANSWER_RATING_REFUSAL_STATUS[refusal ?? "not_found"] }
            );
        }
        if (body.rating === null) {
            await prisma.chatAnswerRating.deleteMany({ where: { messageId: message.id, userId } });
            return NextResponse.json({ rating: null });
        }
        const reason = body.rating === "down" ? body.reason ?? null : null;
        const saved = await prisma.chatAnswerRating.upsert({
            where: { messageId_userId: { messageId: message.id, userId } },
            create: {
                userId,
                messageId: message.id,
                conversationId: message.conversationId,
                modelId: message.modelId,
                rating: body.rating,
                reason,
            },
            update: { rating: body.rating, reason, modelId: message.modelId },
            select: RATING_SELECT,
        });
        return NextResponse.json({ rating: publicChatAnswerRating(saved) });
    } catch (error) {
        const securityResponse = apiSecurityResponse(error);
        if (securityResponse) return securityResponse;
        console.error("Failed to save answer rating:", error);
        return NextResponse.json({ error: "Failed to save the rating." }, { status: 500 });
    }
}
