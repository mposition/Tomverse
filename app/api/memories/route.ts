import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import {
    apiSecurityResponse,
    consumeApiRateLimit,
    readLimitedJson,
} from "@/lib/apiSecurity";
import {
    assertMemoryExtractionEnabled,
    MemoryFeatureDisabledError,
} from "@/lib/appSettings";
import { authOptions } from "@/lib/auth";
import { MEMORY_KINDS, MEMORY_STATUSES } from "@/lib/memoryValidatorCore";
import { createManualMemory, listMemories } from "@/lib/memoryService";

/**
 * Memory list and user-authored creation (policy §21).
 *
 * Listing stays available while the rollout flag is off — the §15
 * never-strand posture: what a user already reviewed and stored must stay
 * visible and deletable through a rollback. Creation is flag-gated.
 */

const clampListParam = (
    value: string | null,
    { fallback, max }: { fallback: number; max: number }
) => {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 0) return fallback;
    return Math.min(parsed, max);
};

export async function GET(req: Request) {
    try {
        const session = await getServerSession(authOptions);
        if (!session?.user) {
            return NextResponse.json({ error: "권한 없음" }, { status: 401 });
        }
        await consumeApiRateLimit(req, session.user.id, "memory-list", {
            minute: 60,
            day: 2000,
        });

        const url = new URL(req.url);
        const status = url.searchParams.get("status");
        const kind = url.searchParams.get("kind");
        const result = await listMemories(session.user.id, {
            status:
                status && (MEMORY_STATUSES as readonly string[]).includes(status)
                    ? status
                    : undefined,
            kind:
                kind && (MEMORY_KINDS as readonly string[]).includes(kind)
                    ? kind
                    : undefined,
            offset: clampListParam(url.searchParams.get("offset"), {
                fallback: 0,
                max: 100_000,
            }),
            limit: clampListParam(url.searchParams.get("limit"), {
                fallback: 50,
                max: 100,
            }),
        });
        return NextResponse.json(result, {
            headers: { "Cache-Control": "no-store" },
        });
    } catch (error) {
        const securityResponse = apiSecurityResponse(error);
        if (securityResponse) return securityResponse;
        console.error("memory list failed", error);
        return NextResponse.json({ error: "서버 오류" }, { status: 500 });
    }
}

const createSchema = z
    .object({
        kind: z.enum(MEMORY_KINDS),
        statement: z.string().trim().min(1).max(1_000),
        sensitivity: z.enum(["standard", "sensitive"]).optional(),
        expiresAt: z.string().datetime().nullable().optional(),
        groundsText: z.string().trim().min(1).max(2_000),
        resolveConflict: z.literal("supersede_existing").optional(),
    })
    .strict();

export async function POST(req: Request) {
    try {
        const session = await getServerSession(authOptions);
        if (!session?.user) {
            return NextResponse.json({ error: "권한 없음" }, { status: 401 });
        }
        await assertMemoryExtractionEnabled();
        await consumeApiRateLimit(req, session.user.id, "memory-create", {
            minute: 20,
            day: 300,
        });

        const body = await readLimitedJson(req, 32 * 1024, createSchema);
        const memoryId = await createManualMemory({
            userId: session.user.id,
            kind: body.kind,
            statement: body.statement,
            sensitivity: body.sensitivity,
            expiresAt: body.expiresAt ?? null,
            groundsText: body.groundsText,
            resolveConflict: body.resolveConflict,
        });
        return NextResponse.json(
            { memoryId },
            { status: 201, headers: { "Cache-Control": "no-store" } }
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
        console.error("memory create failed", error);
        return NextResponse.json({ error: "서버 오류" }, { status: 500 });
    }
}
