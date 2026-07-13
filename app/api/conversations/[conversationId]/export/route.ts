import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/auth";
import {
    formatConversationHeader,
    formatExportMessage,
    sanitizeFileName,
} from "@/lib/exportConversation";
import {
    conversationLockedResponse,
    hasConversationUnlockGrant,
} from "@/lib/conversationLock";
import {
    apiSecurityResponse,
    consumeApiRateLimit,
} from "@/lib/apiSecurity";
import {
    featureNotIncludedResponse,
    getUserBillingPlan,
} from "@/lib/billingEntitlements";

const MESSAGE_PAGE_SIZE = 20;

export async function GET(
    req: Request,
    context: { params: Promise<{ conversationId: string }> }
) {
    try {
        const session = await getServerSession(authOptions);
        const userId = (session?.user as { id?: string } | undefined)?.id;

        if (!userId) {
            return NextResponse.json({ error: "Login required" }, { status: 401 });
        }
        const billingPlan = await getUserBillingPlan(userId);
        if (!billingPlan.allowDownloads) {
            return featureNotIncludedResponse("downloads");
        }
        await consumeApiRateLimit(req, userId, "conversation-export", {
            minute: 10,
            day: 100,
        });

        const { conversationId } = await context.params;

        const conversation = await prisma.conversation.findFirst({
            where: { id: conversationId, userId },
            select: {
                id: true,
                title: true,
                createdAt: true,
                password: true,
            },
        });

        if (!conversation) {
            return NextResponse.json({ error: "Not found" }, { status: 404 });
        }

        if (
            !hasConversationUnlockGrant(
                req,
                userId,
                conversationId,
                conversation.password
            )
        ) {
            return conversationLockedResponse();
        }

        const encoder = new TextEncoder();
        let cursor: string | undefined;
        let headerPending = true;
        const stream = new ReadableStream<Uint8Array>({
            async pull(controller) {
                if (headerPending) {
                    headerPending = false;
                    controller.enqueue(
                        encoder.encode(`${formatConversationHeader(conversation)}\n`)
                    );
                    return;
                }

                const messages = await prisma.message.findMany({
                    where: { conversationId },
                    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
                    take: MESSAGE_PAGE_SIZE,
                    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
                    select: {
                        id: true,
                        role: true,
                        content: true,
                        modelId: true,
                        createdAt: true,
                    },
                });

                if (messages.length === 0) {
                    controller.close();
                    return;
                }

                cursor = messages.at(-1)?.id;
                controller.enqueue(
                    encoder.encode(messages.map(formatExportMessage).join("\n"))
                );

                if (messages.length < MESSAGE_PAGE_SIZE) {
                    controller.close();
                }
            },
        });

        const fileName = `${sanitizeFileName(conversation.title)}.txt`;
        return new Response(stream, {
            headers: {
                "Content-Type": "text/plain; charset=utf-8",
                "Content-Disposition": `attachment; filename="${encodeURIComponent(fileName)}"`,
                "Cache-Control": "no-store",
                "X-Content-Type-Options": "nosniff",
            },
        });
    } catch (error) {
        const securityResponse = apiSecurityResponse(error);
        if (securityResponse) return securityResponse;
        console.error("Conversation export failed:", error);
        return NextResponse.json(
            { error: "Failed to export conversation." },
            { status: 500 }
        );
    }
}
