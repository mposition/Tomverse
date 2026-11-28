import { resolveChatRouteSession } from "@/lib/chatRouteSession";
import { NextResponse } from "next/server";
import { conversationKindNotSupportedResponse, isChatConversationKind } from "@/lib/conversationKindGuard";
import { prisma } from "@/lib/prisma";
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
    formatConversationHeaderMarkdown,
    formatExportMessagePageMarkdown,
} from "@/lib/exportConversationMarkdown";
import {
    ConversationPdfTooLarge,
    PDF_EXPORT_LIMITS,
    conversationPdfSpec,
    renderConversationPdf,
} from "@/lib/exportConversationPdf";
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

/*
  Which messages an export contains, and in what order -- one definition for
  the text, Markdown and PDF forms, so the three cannot drift apart.
*/
const exportMessageWhere = (conversationId: string) => ({ conversationId });
const EXPORT_MESSAGE_ORDER = [{ createdAt: "asc" as const }, { id: "asc" as const }];
const EXPORT_MESSAGE_SELECT = { role: true, content: true, modelId: true, createdAt: true } as const;

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
                    { title, createdAt: conversation.createdAt, productKey: conversation.productKey },
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
        const authentication = await resolveChatRouteSession(req);
    if (authentication.response) return authentication.response;
    const session = authentication.session;
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
            // A temporary Chat is not exportable (lib/temporaryChatAccess.ts);
            // it has no continuation bridge, so the source path above never
            // finds one either.
            where: { id: conversationId, userId, temporaryExpiresAt: null },
            select: {
                id: true,
                title: true,
                createdAt: true,
                password: true, passwordVersion: true,
                kind: true,
                productKey: true,
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
                conversation.password == null ? null : conversation.passwordVersion
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

        // `?format=md` is the same conversation, behind the same plan, rate
        // limit, lock and kind checks above, written as Markdown. The
        // `?include=source` document above stays text-only.
        const asMarkdown = new URL(req.url).searchParams.get("format") === "md";

        // `?format=pdf`: the same messages and header lines as Markdown, behind
        // the same checks above, read whole and rendered by the generated-file
        // PDF writer (lib/exportConversationPdf.ts). Not streamed: a PDF has
        // its page tree at the end, so nothing can be sent before all of it.
        if (new URL(req.url).searchParams.get("format") === "pdf") {
            const messages = await prisma.message.findMany({
                where: exportMessageWhere(conversationId),
                orderBy: EXPORT_MESSAGE_ORDER,
                take: PDF_EXPORT_LIMITS.messages + 1,
                select: EXPORT_MESSAGE_SELECT,
            });
            let spec;
            try {
                spec = conversationPdfSpec({
                    title: displayTitle,
                    createdAt: conversation.createdAt,
                    productKey: conversation.productKey,
                    headerLines: [
                        ...(personalizationNotice ? [personalizationNotice] : []),
                        ...continuationProvenance,
                        ...titleHeaderLines,
                    ],
                    messages,
                });
            } catch (error) {
                if (error instanceof ConversationPdfTooLarge) {
                    return NextResponse.json({ error: error.message, code: "EXPORT_TOO_LARGE" }, { status: 413 });
                }
                throw error;
            }
            const rendered = renderConversationPdf(spec);
            if (!rendered.ok) {
                return NextResponse.json(
                    { error: "This conversation cannot be written as a PDF.", code: rendered.code },
                    { status: rendered.code === "EXPORT_TOO_LARGE" ? 413 : 422 }
                );
            }
            // Rendering takes a moment; a lock set meanwhile is honoured before
            // any byte leaves (the answer-analysis export does the same).
            const current = await prisma.conversation.findFirst({
                where: { id: conversationId, userId },
                select: { password: true, passwordVersion: true },
            });
            if (!current) return NextResponse.json({ error: "Not found" }, { status: 404 });
            if (!hasConversationUnlockGrant(req, userId, conversationId, current.password == null ? null : current.passwordVersion)) {
                return conversationLockedResponse();
            }
            return new Response(rendered.bytes as unknown as BodyInit, {
                headers: {
                    "Content-Type": "application/pdf",
                    "Content-Disposition": conversationExportContentDisposition(displayTitle, ".pdf"),
                    "Cache-Control": "no-store",
                    "X-Content-Type-Options": "nosniff",
                    // Some characters were drawn as boxes; the menu says so.
                    ...(rendered.charactersReplaced ? { "X-Export-Characters-Replaced": "1" } : {}),
                },
            });
        }

        const encoder = new TextEncoder();
        let cursor: string | undefined;
        let headerPending = true;
        const stream = new ReadableStream<Uint8Array>({
            async pull(controller) {
                if (headerPending) {
                    headerPending = false;
                    const headerInput = {
                        title: displayTitle,
                        createdAt: conversation.createdAt,
                        productKey: conversation.productKey,
                    };
                    const headerLines = [...continuationProvenance, ...titleHeaderLines];
                    controller.enqueue(
                        encoder.encode(
                            `${(asMarkdown ? formatConversationHeaderMarkdown : formatConversationHeader)(headerInput, personalizationNotice, headerLines)}\n`
                        )
                    );
                    return;
                }

                const messages = await prisma.message.findMany({
                    where: exportMessageWhere(conversationId),
                    orderBy: EXPORT_MESSAGE_ORDER,
                    take: MESSAGE_PAGE_SIZE,
                    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
                    select: { id: true, ...EXPORT_MESSAGE_SELECT },
                });

                if (messages.length === 0) {
                    controller.close();
                    return;
                }

                cursor = messages.at(-1)?.id;
                controller.enqueue(
                    encoder.encode(
                        asMarkdown
                            ? formatExportMessagePageMarkdown(messages)
                            : messages.map(formatExportMessage).join("\n")
                    )
                );

                if (messages.length < MESSAGE_PAGE_SIZE) {
                    controller.close();
                }
            },
        });

        return new Response(stream, {
            headers: {
                "Content-Type": asMarkdown
                    ? "text/markdown; charset=utf-8"
                    : "text/plain; charset=utf-8",
                "Content-Disposition": asMarkdown
                    ? conversationExportContentDisposition(displayTitle, ".md")
                    : conversationExportContentDisposition(displayTitle),
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
