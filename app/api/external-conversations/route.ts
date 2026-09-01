import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import {
    apiSecurityResponse,
    consumeApiRateLimit,
} from "@/lib/apiSecurity";
import {
    assertExternalImportEnabled,
    ExternalImportDisabledError,
    isExternalContinuationEnabledCached,
} from "@/lib/appSettings";
import { authOptions } from "@/lib/auth";
import { listExternalConversations } from "@/lib/externalImportService";

const clampListParam = (
    value: string | null,
    { fallback, max }: { fallback: number; max: number }
) => {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 0) return fallback;
    return Math.min(parsed, max);
};

/** Finalized conversations for the account-private viewer (policy §21). */
export async function GET(req: Request) {
    try {
        const session = await getServerSession(authOptions);
        if (!session?.user) {
            return NextResponse.json({ error: "권한 없음" }, { status: 401 });
        }
        await assertExternalImportEnabled();
        await consumeApiRateLimit(
            req,
            session.user.id,
            "external-conversations-list",
            { minute: 60, day: 2000 }
        );

        const url = new URL(req.url);
        // Display-only, and deliberately the cached read.
        //
        // This decides whether the list draws a quick action, not whether one
        // may be taken: `POST …/continuations` calls
        // `assertExternalContinuationEnabled()`, which reads the row
        // uncached, and that is the authority
        // (docs/policy/external-conversation-continuation.md §7.1). A stale
        // `true` here therefore costs a button that answers 403 and says so,
        // never a continuation created after a rollback.
        const continuationEnabled = await isExternalContinuationEnabledCached();
        const result = await listExternalConversations(session.user.id, {
            offset: clampListParam(url.searchParams.get("offset"), {
                fallback: 0,
                max: 100_000,
            }),
            limit: clampListParam(url.searchParams.get("limit"), {
                fallback: 50,
                max: 100,
            }),
        });
        return NextResponse.json(
            { ...result, continuationEnabled },
            { headers: { "Cache-Control": "no-store" } }
        );
    } catch (error) {
        if (error instanceof ExternalImportDisabledError) {
            return NextResponse.json(
                { error: error.message, code: "EXTERNAL_IMPORT_DISABLED" },
                { status: 403 }
            );
        }
        const securityResponse = apiSecurityResponse(error);
        if (securityResponse) return securityResponse;
        console.error("external conversations list failed", error);
        return NextResponse.json({ error: "서버 오류" }, { status: 500 });
    }
}
