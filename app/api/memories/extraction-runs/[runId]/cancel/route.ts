import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import {
    apiSecurityResponse,
    consumeApiRateLimit,
} from "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
import { cancelMemoryExtractionRun } from "@/lib/memoryExtractionService";

/**
 * User cancel (policy §11: deterministic release). Deliberately not gated on
 * the extraction flag: turning the rollout off must never strand an active
 * run un-cancellable — the same §15 rollback posture as import deletion.
 */
export async function POST(
    req: Request,
    context: RouteContext<"/api/memories/extraction-runs/[runId]/cancel">
) {
    try {
        const session = await getServerSession(authOptions);
        if (!session?.user) {
            return NextResponse.json({ error: "권한 없음" }, { status: 401 });
        }
        await consumeApiRateLimit(
            req,
            session.user.id,
            "memory-extraction-cancel",
            { minute: 10, day: 200 }
        );

        const params = await context.params;
        const result = await cancelMemoryExtractionRun(
            session.user.id,
            params.runId
        );
        return NextResponse.json(result, {
            headers: { "Cache-Control": "no-store" },
        });
    } catch (error) {
        const securityResponse = apiSecurityResponse(error);
        if (securityResponse) return securityResponse;
        console.error("memory extraction run cancel failed", error);
        return NextResponse.json({ error: "서버 오류" }, { status: 500 });
    }
}
