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
import { bulkApproveMemories } from "@/lib/memoryService";

/**
 * §8.4 bulk approval: only standard-sensitivity candidates that re-validate
 * as cleanly accepted and bulk-safe. Everything else is skipped and stays
 * individually reviewable — the response reports counts, never content.
 */
export async function POST(req: Request) {
    try {
        const session = await getServerSession(authOptions);
        if (!session?.user) {
            return NextResponse.json({ error: "권한 없음" }, { status: 401 });
        }
        await assertMemoryExtractionEnabled();
        await consumeApiRateLimit(req, session.user.id, "memory-bulk-approve", {
            minute: 5,
            day: 50,
        });

        const result = await bulkApproveMemories(session.user.id);
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
        console.error("memory bulk approve failed", error);
        return NextResponse.json({ error: "서버 오류" }, { status: 500 });
    }
}
