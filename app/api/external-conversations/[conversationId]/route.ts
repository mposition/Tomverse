import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import {
    apiSecurityResponse,
    consumeApiRateLimit,
} from "@/lib/apiSecurity";
import {
    assertExternalImportEnabled,
    ExternalImportDisabledError,
} from "@/lib/appSettings";
import { authOptions } from "@/lib/auth";
import { lockErrorResponse } from "@/lib/conversationLock";
import {
    deleteExternalConversationSnapshot,
    getExternalConversation,
    previewExternalSourceDeletion,
} from "@/lib/externalImportService";
import {
    readSourceDeletionDispositions,
    wantsMemoryImpact,
} from "@/lib/externalSourceDeletionRequest";

const clampListParam = (
    value: string | null,
    { fallback, max }: { fallback: number; max: number }
) => {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 0) return fallback;
    return Math.min(parsed, max);
};

/**
 * Read-only view of one finalized conversation (policy §21). The content is
 * returned as the stored plain text; the viewer renders it inertly, never as
 * HTML (§4, §19).
 */
export async function GET(
    req: Request,
    context: RouteContext<"/api/external-conversations/[conversationId]">
) {
    try {
        const session = await getServerSession(authOptions);
        if (!session?.user) {
            return NextResponse.json({ error: "권한 없음" }, { status: 401 });
        }
        await assertExternalImportEnabled();
        await consumeApiRateLimit(
            req,
            session.user.id,
            "external-conversations-read",
            { minute: 120, day: 4000 }
        );

        const url = new URL(req.url);
        const params = await context.params;
        const conversation = await getExternalConversation(
            session.user.id,
            params.conversationId,
            {
                request: req,
                offset: clampListParam(url.searchParams.get("offset"), {
                    fallback: 0,
                    max: 1_000_000,
                }),
                limit: clampListParam(url.searchParams.get("limit"), {
                    fallback: 100,
                    max: 200,
                }),
            }
        );
        // Only when asked for: the viewer's delete confirmation needs it,
        // paging through messages does not (§13.1).
        const memoryImpact = wantsMemoryImpact(url)
            ? await previewExternalSourceDeletion(session.user.id, {
                  conversationId: params.conversationId,
              })
            : undefined;
        return NextResponse.json({ ...conversation, memoryImpact }, {
            headers: { "Cache-Control": "no-store" },
        });
    } catch (error) {
        if (error instanceof ExternalImportDisabledError) {
            return NextResponse.json(
                { error: error.message, code: "EXTERNAL_IMPORT_DISABLED" },
                { status: 403 }
            );
        }
        const securityResponse = apiSecurityResponse(error);
        if (securityResponse) return securityResponse;
        // 423 CONVERSATION_LOCKED, the same contract the native conversation
        // routes answer with (§7).
        const lockError = lockErrorResponse(error);
        if (lockError) return lockError;
        console.error("external conversation read failed", error);
        return NextResponse.json({ error: "서버 오류" }, { status: 500 });
    }
}

/**
 * Deletes one immutable snapshot (§4.2). Like the import DELETE, this stays
 * available while the rollout flag is off: a rollback must never strand
 * imported data beyond its owner's reach (§15).
 */
export async function DELETE(
    req: Request,
    context: RouteContext<"/api/external-conversations/[conversationId]">
) {
    try {
        const session = await getServerSession(authOptions);
        if (!session?.user) {
            return NextResponse.json({ error: "권한 없음" }, { status: 401 });
        }
        await consumeApiRateLimit(
            req,
            session.user.id,
            "external-conversations-delete",
            { minute: 30, day: 500 }
        );

        const params = await context.params;
        const result = await deleteExternalConversationSnapshot(
            session.user.id,
            params.conversationId,
            readSourceDeletionDispositions(new URL(req.url))
        );
        return NextResponse.json(result, {
            headers: { "Cache-Control": "no-store" },
        });
    } catch (error) {
        const securityResponse = apiSecurityResponse(error);
        if (securityResponse) return securityResponse;
        console.error("external conversation delete failed", error);
        return NextResponse.json({ error: "서버 오류" }, { status: 500 });
    }
}
