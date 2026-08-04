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
import { getMemoryExtractionRun } from "@/lib/memoryExtractionService";

/** Run progress for the owner (policy §21). */
export async function GET(
    req: Request,
    context: RouteContext<"/api/memories/extraction-runs/[runId]">
) {
    try {
        const session = await getServerSession(authOptions);
        if (!session?.user) {
            return NextResponse.json({ error: "권한 없음" }, { status: 401 });
        }
        await assertMemoryExtractionEnabled();
        await consumeApiRateLimit(
            req,
            session.user.id,
            "memory-extraction-status",
            { minute: 60, day: 2000 }
        );

        const params = await context.params;
        const run = await getMemoryExtractionRun(session.user.id, params.runId);
        return NextResponse.json(run, {
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
        console.error("memory extraction run status failed", error);
        return NextResponse.json({ error: "서버 오류" }, { status: 500 });
    }
}
