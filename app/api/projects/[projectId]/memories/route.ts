export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { z } from "zod";
import { readLimitedJson } from "@/lib/apiSecurity";
import { assertMemoryExtractionEnabled } from "@/lib/appSettings";
import { MEMORY_KINDS, MEMORY_STATUSES } from "@/lib/memoryValidatorCore";
import { createManualMemory, listMemories } from "@/lib/memoryService";
import { loadOwnedProject } from "@/lib/projectWorkspaceService";
import { NO_STORE, projectErrorResponse, projectRouteUser } from "@/lib/projectRouteSupport";

/**
 * A project's own memories: the existing memory store and review rules with
 * the project as the scope. Personal memories are not listed here, and these
 * are never used outside this project.
 */
type Context = { params: Promise<{ projectId: string }> };

const createSchema = z.object({
    kind: z.enum(MEMORY_KINDS),
    statement: z.string().trim().min(1).max(1_000),
    sensitivity: z.enum(["standard", "sensitive"]).optional(),
    expiresAt: z.string().datetime().nullable().optional(),
    groundsText: z.string().trim().min(1).max(2_000),
    canonicalKey: z.string().max(96).nullable().optional(),
    resolveConflict: z.literal("supersede_existing").optional(),
}).strict();

export async function GET(req: Request, context: Context) {
    try {
        const auth = await projectRouteUser(req, "project-memory-list", { minute: 60, day: 2_000 });
        if (auth.response) return auth.response;
        const { projectId } = await context.params;
        await loadOwnedProject(auth.userId, projectId);
        const url = new URL(req.url);
        const status = url.searchParams.get("status");
        // `scope=personal`: the account's personal memories, offered for an
        // explicit move into this project. Never mixed into the project list.
        const personal = url.searchParams.get("scope") === "personal";
        const offset = Math.max(0, Math.min(100_000, Number(url.searchParams.get("offset")) || 0));
        const result = await listMemories(auth.userId, {
            projectId: personal ? null : projectId,
            status: status && (MEMORY_STATUSES as readonly string[]).includes(status) ? status : undefined,
            offset,
            limit: 100,
        });
        return NextResponse.json(result, { headers: NO_STORE });
    } catch (error) {
        return projectErrorResponse(error, "projects.memories.list");
    }
}

export async function POST(req: Request, context: Context) {
    try {
        const auth = await projectRouteUser(req, "memory-create", { minute: 20, day: 300 });
        if (auth.response) return auth.response;
        await assertMemoryExtractionEnabled();
        const { projectId } = await context.params;
        const body = await readLimitedJson(req, 32 * 1024, createSchema);
        const memoryId = await createManualMemory({
            userId: auth.userId,
            projectId,
            kind: body.kind,
            statement: body.statement,
            sensitivity: body.sensitivity,
            expiresAt: body.expiresAt ?? null,
            groundsText: body.groundsText,
            canonicalKey: body.canonicalKey,
            resolveConflict: body.resolveConflict,
        });
        return NextResponse.json({ memoryId }, { status: 201, headers: NO_STORE });
    } catch (error) {
        return projectErrorResponse(error, "projects.memories.create");
    }
}
