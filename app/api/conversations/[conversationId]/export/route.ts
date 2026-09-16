import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { conversationKindNotSupportedResponse, isChatConversationKind } from "@/lib/conversationKindGuard";
import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/auth";
import { isMemoryInjectionEnabled } from "@/lib/appSettings";
import { conversationExportPersonalizationNotice } from "@/lib/memorySharingNotice";
import { continuationExportProvenance } from "@/lib/continuationSharingPolicy";
import { continuationProviderDisplay } from "@/lib/externalContinuationSeedPrompt";
import { getContinuationBridge } from "@/lib/externalContinuationService";
import {
    CONTINUATION_NAMING_BRIDGE_SELECT,
    DISPLAY_TIME_ZONE_HEADER,
    continuationExportTitle,
    effectiveDisplayTimeZone,
} from "@/lib/continuationTitleContext";
import { continuationExportCopy } from "@/lib/continuationExportCopy";
import {
    conversationExportContentDisposition,
    formatConversationHeader,
    formatExportMessage,
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
import {
    buildContinuationSourceExport,
    continuationSourceExportStillPermitted,
} from "@/lib/continuationSourceExport";

const MESSAGE_PAGE_SIZE = 20;

/**
 * The continuation's own turns *and* the imported original, as one file.
 *
 * Refusals are their own codes rather than a generic failure: "the original
 * was deleted" and "the original is locked" are different situations with
 * different next steps, and a file quietly missing its first half would be
 * indistinguishable from one that never had it.
 */
async function sourceIncludedExport(
    req: Request,
    userId: string,
    conversationId: string,
    // Read once by the caller: the raw header has exactly one reader
    // (lib/continuationTitleContext.ts).
    timeZone: string
): Promise<Response> {
    const copy = continuationExportCopy(req);
    const personalizationNotice = (await isMemoryInjectionEnabled())
        ? conversationExportPersonalizationNotice()
        : undefined;

    let permissionInput: {
        bridgeId: string;
        externalConversationId: string;
        conversationPassword: string | null;
        snapshotPassword: string | null;
    } | null = null;
    const built = await buildContinuationSourceExport({
        request: req,
        userId,
        conversationId,
        providerLabel: continuationProviderDisplay,
        header: ({ conversation, bridge }) => {
            const { title, headerLines } = continuationExportTitle({
                storedTitle: conversation.title,
                bridge,
                timeZone,
                copy,
            });
            return {
                title,
                text: `${formatConversationHeader(
                    { title, createdAt: conversation.createdAt },
                    personalizationNotice,
                    [
                        ...continuationExportProvenance({
                            providerLabel: continuationProviderDisplay(bridge.provider),
                            importedAt: bridge.sourceImportedAt,
                            sourceDeleted: false,
                            includesSource: true,
                        }),
                        ...headerLines,
                    ]
                )}\n`,
            };
        },
    });
    if ("notFound" in built) return NextResponse.json({ error: "Not found" }, { status: 404 });
    if ("locked" in built) return conversationLockedResponse();
    if ("kindNotSupported" in built) return conversationKindNotSupportedResponse();
    if (!built.ok) {
        return NextResponse.json(
            { error: "This conversation's original cannot be included.", code: built.refusal.code },
            { status: built.refusal.status }
        );
    }
    permissionInput = built.permission;

    // Read once more, outside the snapshot: permission is decided here, and a
    // source deleted or re-locked since is refused rather than sent.
    const stale = await continuationSourceExportStillPermitted({
        request: req,
        userId,
        conversationId,
        ...permissionInput,
    });
    if (stale) {
        return NextResponse.json(
            { error: "This conversation's original cannot be included.", code: stale.code },
            { status: stale.status }
        );
    }

    return new Response(built.document.bytes as unknown as BodyInit, {
        headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "Content-Disposition": conversationExportContentDisposition(built.title),
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
            // What the browser must have received before it saves the file.
            "X-Export-Bytes": String(built.document.bytes.byteLength),
            "X-Export-SHA256": built.document.sha256,
        },
    });
}

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

        /*
          `?include=source` is the imported original in the same file
          (docs/policy/external-conversation-continuation.md §9). A different
          document, so a different path: it is read in one snapshot and
          assembled before anything is sent, while the ordinary export below
          keeps streaming page by page, byte for byte as it always has.
        */
        const displayTimeZone = effectiveDisplayTimeZone(
            req.headers.get(DISPLAY_TIME_ZONE_HEADER)
        );
        if (new URL(req.url).searchParams.get("include") === "source") {
            return await sourceIncludedExport(req, userId, conversationId, displayTimeZone);
        }

        const conversation = await prisma.conversation.findFirst({
            where: { id: conversationId, userId },
            select: {
                id: true,
                title: true,
                createdAt: true,
                password: true,
                kind: true,
                // The naming columns the conversation list reads, read the
                // same way: the file has to be named what the list calls the
                // conversation (lib/continuationTitleContext.ts).
                continuationBridge: { select: CONTINUATION_NAMING_BRIDGE_SELECT },
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
        // The export format is a text-message transcript; image
        // conversations have none (docs/policy/image-generation.md §1).
        if (!isChatConversationKind(conversation.kind)) {
            return conversationKindNotSupportedResponse();
        }

        // §13.3: unconditional for every export while injection is available,
        // so the line itself discloses nothing about this author.
        const personalizationNotice = (await isMemoryInjectionEnabled())
            ? conversationExportPersonalizationNotice()
            : undefined;

        // §9: a continuation's export names where the conversation came from
        // and says the imported original is a separate download. It never
        // copies the imported transcript in -- that would put a third-party
        // conversation into a file the user may forward anywhere, and it is the
        // silent widening the policy exists to forbid.
        const bridge = await getContinuationBridge(userId, conversationId);
        const continuationProvenance = bridge
            ? continuationExportProvenance({
                  providerLabel: continuationProviderDisplay(bridge.provider),
                  importedAt: bridge.sourceImportedAt,
                  sourceDeleted: bridge.externalConversationId === null,
              })
            : [];

        // What the conversation list calls this conversation, so the filename
        // and the file's own `Conversation:` line match the row the user
        // clicked. The stored title alone is the internal placeholder for a
        // continuation nobody has named. Resolved from this row, never from a
        // title the request could carry. The file's header lines are English,
        // so its fallback is too; its date is the list's, from the same
        // display-zone hint (formatting only).
        const { title: displayTitle, headerLines: titleHeaderLines } =
            continuationExportTitle({
                storedTitle: conversation.title,
                bridge: conversation.continuationBridge,
                timeZone: displayTimeZone,
                // The page's words for the title, so the filename is the
                // name the list shows; the header lines stay English.
                copy: continuationExportCopy(req),
            });

        const encoder = new TextEncoder();
        let cursor: string | undefined;
        let headerPending = true;
        const stream = new ReadableStream<Uint8Array>({
            async pull(controller) {
                if (headerPending) {
                    headerPending = false;
                    controller.enqueue(
                        encoder.encode(
                            `${formatConversationHeader({ title: displayTitle, createdAt: conversation.createdAt }, personalizationNotice, [...continuationProvenance, ...titleHeaderLines])}\n`
                        )
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

        return new Response(stream, {
            headers: {
                "Content-Type": "text/plain; charset=utf-8",
                "Content-Disposition":
                    conversationExportContentDisposition(displayTitle),
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
