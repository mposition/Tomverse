import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/auth";
import {
    formatConversationHeader,
    formatExportMessage,
} from "@/lib/exportConversation";
import { hasConversationUnlockGrant } from "@/lib/conversationLock";
import {
    apiSecurityResponse,
    consumeApiRateLimit,
} from "@/lib/apiSecurity";
import {
    featureNotIncludedResponse,
    getUserBillingPlan,
} from "@/lib/billingEntitlements";

const MESSAGE_PAGE_SIZE = 20;

export async function GET(req: Request) {
    try {
        const session = await getServerSession(authOptions);
        const userId = (session?.user as { id?: string } | undefined)?.id;

        if (!userId) {
            return NextResponse.json(
                { error: "Login required" },
                { status: 401 }
            );
        }
        const billingPlan = await getUserBillingPlan(userId);
        if (!billingPlan.allowDownloads) {
            return featureNotIncludedResponse("downloads");
        }
        await consumeApiRateLimit(req, userId, "export-all", {
            minute: 5,
            day: 20,
        });

        const conversations = await prisma.conversation.findMany({
            where: { userId },
            orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
            select: {
                id: true,
                title: true,
                createdAt: true,
                password: true,
            },
        });
        const exportable = conversations.filter((conversation) =>
            hasConversationUnlockGrant(
                req,
                userId,
                conversation.id,
                conversation.password
            )
        );
        const lockedCount = conversations.length - exportable.length;
        const encoder = new TextEncoder();
        let conversationIndex = 0;
        let messageCursor: string | undefined;
        let headerPending = true;
        let introPending = true;

        const stream = new ReadableStream<Uint8Array>({
            async pull(controller) {
                if (introPending) {
                    introPending = false;
                    if (lockedCount > 0) {
                        controller.enqueue(
                            encoder.encode(
                                `Tomverse AI Export\n\n${lockedCount} locked conversation(s) were excluded. Unlock them before exporting to include their contents.\n\n`
                            )
                        );
                        return;
                    }
                    if (exportable.length === 0) {
                        controller.enqueue(
                            encoder.encode(
                                "Tomverse AI Export\n\nNo conversations found.\n"
                            )
                        );
                        controller.close();
                        return;
                    }
                }

                const conversation = exportable[conversationIndex];
                if (!conversation) {
                    controller.close();
                    return;
                }

                if (headerPending) {
                    headerPending = false;
                    controller.enqueue(
                        encoder.encode(
                            `${conversationIndex > 0 ? "\n\n##################################################\n\n\n" : ""}${formatConversationHeader(conversation)}\n`
                        )
                    );
                    return;
                }

                const messages = await prisma.message.findMany({
                    where: { conversationId: conversation.id },
                    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
                    take: MESSAGE_PAGE_SIZE,
                    ...(messageCursor
                        ? { cursor: { id: messageCursor }, skip: 1 }
                        : {}),
                    select: {
                        id: true,
                        role: true,
                        content: true,
                        modelId: true,
                        createdAt: true,
                    },
                });

                if (messages.length > 0) {
                    messageCursor = messages.at(-1)?.id;
                    controller.enqueue(
                        encoder.encode(
                            messages.map(formatExportMessage).join("\n")
                        )
                    );
                }

                if (messages.length < MESSAGE_PAGE_SIZE) {
                    conversationIndex += 1;
                    messageCursor = undefined;
                    headerPending = true;
                }
            },
        });

        return new Response(stream, {
            headers: {
                "Content-Type": "text/plain; charset=utf-8",
                "Content-Disposition":
                    'attachment; filename="tomverse-all-conversations.txt"',
                "Cache-Control": "no-store",
                "X-Content-Type-Options": "nosniff",
            },
        });
    } catch (error) {
        const securityResponse = apiSecurityResponse(error);
        if (securityResponse) return securityResponse;
        console.error("Conversation export failed:", error);
        return NextResponse.json(
            { error: "Failed to export conversations." },
            { status: 500 }
        );
    }
}
