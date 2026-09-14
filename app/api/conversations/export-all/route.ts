import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/auth";
import { isMemoryInjectionEnabled } from "@/lib/appSettings";
import { conversationExportPersonalizationNotice } from "@/lib/memorySharingNotice";
import {
    formatConversationHeader,
    formatExportMessage,
} from "@/lib/exportConversation";
import { hasConversationUnlockGrant } from "@/lib/conversationLock";
import {
    CONTINUATION_NAMING_BRIDGE_SELECT,
    DISPLAY_TIME_ZONE_HEADER,
    continuationExportTitle,
    effectiveDisplayTimeZone,
    type ContinuationNamingBridge,
} from "@/lib/continuationTitleContext";
import { continuationExportCopy } from "@/lib/continuationExportCopy";
import { continuationExportProvenance } from "@/lib/continuationSharingPolicy";
import { continuationProviderDisplay } from "@/lib/externalContinuationSeedPrompt";
import {
    apiSecurityResponse,
    consumeApiRateLimit,
} from "@/lib/apiSecurity";
import {
    featureNotIncludedResponse,
    getUserBillingPlan,
} from "@/lib/billingEntitlements";

const MESSAGE_PAGE_SIZE = 20;
const MAX_EXPORTED_CONVERSATIONS = 2_000;

/**
 * One conversation's header, written as the single export writes it: the
 * title the conversation list shows, and for a continuation the §9 provenance
 * lines (docs/policy/external-conversation-continuation.md §9). Without them a
 * continuation in this file reads as if Tomverse had produced every answer
 * with nothing before it.
 */
function exportHeader(
    conversation: {
        title: string;
        createdAt: Date;
        continuationBridge: (ContinuationNamingBridge & {
            sourceImportedAt: Date;
        }) | null;
    },
    personalizationNotice: string | undefined,
    timeZone: string,
    copy: ReturnType<typeof continuationExportCopy>
) {
    const bridge = conversation.continuationBridge;
    const { title, headerLines } = continuationExportTitle({
        storedTitle: conversation.title,
        bridge,
        timeZone,
        copy,
    });
    return formatConversationHeader(
        { title, createdAt: conversation.createdAt },
        personalizationNotice,
        [
            ...(bridge
                ? continuationExportProvenance({
                      providerLabel: continuationProviderDisplay(bridge.provider),
                      importedAt: bridge.sourceImportedAt,
                      sourceDeleted: bridge.externalConversationId === null,
                  })
                : []),
            ...headerLines,
        ]
    );
}

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
            take: MAX_EXPORTED_CONVERSATIONS,
            select: {
                id: true,
                title: true,
                createdAt: true,
                password: true,
                // Read for the title and the §9 provenance lines, the two
                // things the single export also writes for a continuation
                // (lib/continuationDisplayTitle.ts,
                // lib/continuationSharingPolicy.ts). The title and password
                // are the same two columns the conversation list reads; the
                // rest is the bridge's own provenance, not the source's words.
                continuationBridge: {
                    select: {
                        ...CONTINUATION_NAMING_BRIDGE_SELECT,
                        sourceImportedAt: true,
                    },
                },
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
        // Formatting only: the date in a continuation's fallback title
        // (lib/continuationTitleContext.ts).
        const displayTimeZone = effectiveDisplayTimeZone(
            req.headers.get(DISPLAY_TIME_ZONE_HEADER)
        );
        // And the page's words for a continuation's fallback title.
        const exportCopy = continuationExportCopy(req);
        // §13.3: resolved once for the whole archive, and unconditional
        // while injection is available — every conversation in the file
        // carries it, so the line discloses nothing about which of them
        // was actually personalised.
        const personalizationNotice = (await isMemoryInjectionEnabled())
            ? conversationExportPersonalizationNotice()
            : undefined;

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
                                `Tomverse Export\n\n${lockedCount} locked conversation(s) were excluded. Unlock them before exporting to include their contents.\n\n`
                            )
                        );
                        return;
                    }
                    if (exportable.length === 0) {
                        controller.enqueue(
                            encoder.encode(
                                "Tomverse Export\n\nNo conversations found.\n"
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
                            `${conversationIndex > 0 ? "\n\n##################################################\n\n\n" : ""}${exportHeader(conversation, personalizationNotice, displayTimeZone, exportCopy)}\n`
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
