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
import {
    approveMemory,
    deleteMemory,
    editMemory,
    rejectMemory,
    setMemoryPinned,
} from "@/lib/memoryService";

/**
 * Review actions on one memory (policy §21 PATCH) and deletion. PATCH is
 * flag-gated; DELETE stays available through a rollback (§15).
 */

const patchSchema = z
    .discriminatedUnion("action", [
        z
            .object({
                action: z.literal("approve"),
                resolveConflict: z.literal("supersede_existing").optional(),
            })
            .strict(),
        z.object({ action: z.literal("reject") }).strict(),
        z
            .object({
                action: z.literal("edit"),
                statement: z.string().trim().min(1).max(1_000).optional(),
                expiresAt: z.string().datetime().nullable().optional(),
                sensitivity: z.enum(["standard", "sensitive"]).optional(),
            })
            .strict(),
        z.object({ action: z.literal("pin") }).strict(),
        z.object({ action: z.literal("unpin") }).strict(),
    ]);

export async function PATCH(
    req: Request,
    context: RouteContext<"/api/memories/[memoryId]">
) {
    try {
        const session = await getServerSession(authOptions);
        if (!session?.user) {
            return NextResponse.json({ error: "권한 없음" }, { status: 401 });
        }
        await assertMemoryExtractionEnabled();
        await consumeApiRateLimit(req, session.user.id, "memory-update", {
            minute: 60,
            day: 1000,
        });

        const body = await readLimitedJson(req, 32 * 1024, patchSchema);
        const params = await context.params;
        const memoryId = params.memoryId;
        const userId = session.user.id;

        if (body.action === "approve") {
            await approveMemory({
                userId,
                memoryId,
                resolveConflict: body.resolveConflict,
            });
        } else if (body.action === "reject") {
            await rejectMemory(userId, memoryId);
        } else if (body.action === "edit") {
            await editMemory({
                userId,
                memoryId,
                statement: body.statement,
                expiresAt: body.expiresAt,
                sensitivity: body.sensitivity,
            });
        } else if (body.action === "pin" || body.action === "unpin") {
            await setMemoryPinned(userId, memoryId, body.action === "pin");
        }
        return NextResponse.json(
            { ok: true },
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
        console.error("memory update failed", error);
        return NextResponse.json({ error: "서버 오류" }, { status: 500 });
    }
}

export async function DELETE(
    req: Request,
    context: RouteContext<"/api/memories/[memoryId]">
) {
    try {
        const session = await getServerSession(authOptions);
        if (!session?.user) {
            return NextResponse.json({ error: "권한 없음" }, { status: 401 });
        }
        await consumeApiRateLimit(req, session.user.id, "memory-delete", {
            minute: 30,
            day: 500,
        });

        const params = await context.params;
        const result = await deleteMemory(session.user.id, params.memoryId);
        return NextResponse.json(result, {
            headers: { "Cache-Control": "no-store" },
        });
    } catch (error) {
        const securityResponse = apiSecurityResponse(error);
        if (securityResponse) return securityResponse;
        console.error("memory delete failed", error);
        return NextResponse.json({ error: "서버 오류" }, { status: 500 });
    }
}
