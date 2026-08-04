import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { apiSecurityResponse, consumeApiRateLimit } from "@/lib/apiSecurity";
import {
    assertMemoryExtractionEnabled,
    MemoryFeatureDisabledError,
} from "@/lib/appSettings";
import { authOptions } from "@/lib/auth";
import { listAvailableExtractionPairs } from "@/lib/memoryExtractionCatalogue";
import type { ModelTier } from "@/lib/models";

/**
 * The extraction models this account may actually run (policy §12.1, §21).
 *
 * Flag-gated, unlike the memory list: this endpoint exists only to start work,
 * so with the rollout flag off there is nothing to strand and the §15
 * never-strand posture does not apply. An empty `pairs` array is the normal
 * answer until a pair passes eval — the screen states that rather than
 * offering a control whose only outcome is 403.
 */
const normalizePlan = (value: unknown): ModelTier | "Guest" =>
    value === "Pro" || value === "Max" ? value : "Free";

export async function GET(req: Request) {
    try {
        const session = await getServerSession(authOptions);
        if (!session?.user) {
            return NextResponse.json({ error: "권한 없음" }, { status: 401 });
        }
        await assertMemoryExtractionEnabled();
        await consumeApiRateLimit(
            req,
            session.user.id,
            "memory-extraction-models",
            { minute: 30, day: 500 }
        );

        const pairs = await listAvailableExtractionPairs(
            normalizePlan(session.user.plan)
        );
        return NextResponse.json(
            { pairs },
            { headers: { "Cache-Control": "no-store" } }
        );
    } catch (error) {
        if (error instanceof MemoryFeatureDisabledError) {
            return NextResponse.json(
                { error: error.message, code: "MEMORY_FEATURE_DISABLED" },
                { status: 403 }
            );
        }
        const securityResponse = apiSecurityResponse(error);
        if (securityResponse) return securityResponse;
        console.error("memory extraction model list failed", error);
        return NextResponse.json({ error: "서버 오류" }, { status: 500 });
    }
}
