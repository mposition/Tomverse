import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import {
    apiSecurityResponse,
    consumeApiRateLimit,
} from "@/lib/apiSecurity";
import {
    assertMemoryExtractionEnabled,
    MemoryFeatureDisabledError,
} from "@/lib/appSettings";
import { authOptions } from "@/lib/auth";
import { listMemoryExtractionRuns } from "@/lib/memoryExtractionCatalogue";

/**
 * Recent extraction runs and whichever one is still open
 * (docs/policy/external-conversation-import-and-memory.md §11, §21).
 *
 * Read-only. Since 2026-10-24 runs are started by the server when an import
 * finishes (lib/memoryExtractionAuto.ts) and there is no endpoint that
 * creates one; the settings screen reads this to say memories are still
 * being organised.
 */
export async function GET(req: Request) {
    try {
        const session = await getServerSession(authOptions);
        if (!session?.user) {
            return NextResponse.json({ error: "권한 없음" }, { status: 401 });
        }
        await assertMemoryExtractionEnabled();
        await consumeApiRateLimit(req, session.user.id, "memory-extraction-list", {
            minute: 60,
            day: 2000,
        });

        const result = await listMemoryExtractionRuns(session.user.id);
        return NextResponse.json(result, {
            headers: { "Cache-Control": "no-store" },
        });
    } catch (error) {
        if (error instanceof MemoryFeatureDisabledError) {
            return NextResponse.json(
                { error: error.message, code: "MEMORY_FEATURE_DISABLED" },
                { status: 403 }
            );
        }
        const securityResponse = apiSecurityResponse(error);
        if (securityResponse) return securityResponse;
        console.error("memory extraction run list failed", error);
        return NextResponse.json({ error: "서버 오류" }, { status: 500 });
    }
}
