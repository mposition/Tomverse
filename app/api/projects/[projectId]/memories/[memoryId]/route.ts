export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { z } from "zod";
import { ApiSecurityError, readLimitedJson } from "@/lib/apiSecurity";
import { deleteMemory, editMemory, getMemoryConflictContext, setMemoryPinned } from "@/lib/memoryService";
import { prisma } from "@/lib/prisma";
import { NO_STORE, projectErrorResponse, projectRouteUser } from "@/lib/projectRouteSupport";

type Context = { params: Promise<{ projectId: string; memoryId: string }> };

/** The memory must be this project's own; any other id reads as not found. */
async function assertProjectMemory(userId: string, projectId: string, memoryId: string) {
    const found = await prisma.memoryItem.count({ where: { id: memoryId, userId, projectId } });
    if (!found) throw new ApiSecurityError(404, "NOT_FOUND", "Memory not found.");
}

const patchSchema = z.discriminatedUnion("action", [
    z.object({
        action: z.literal("edit"),
        statement: z.string().trim().min(1).max(1_000).optional(),
        expiresAt: z.string().datetime().nullable().optional(),
    }).strict(),
    z.object({ action: z.literal("pin"), pinned: z.boolean() }).strict(),
]);

export async function GET(req: Request, context: Context) {
    try {
        const auth = await projectRouteUser(req, "project-memory-list", { minute: 60, day: 2_000 });
        if (auth.response) return auth.response;
        const { projectId, memoryId } = await context.params;
        await assertProjectMemory(auth.userId, projectId, memoryId);
        return NextResponse.json(await getMemoryConflictContext(auth.userId, memoryId), { headers: NO_STORE });
    } catch (error) {
        return projectErrorResponse(error, "projects.memories.read");
    }
}

export async function PATCH(req: Request, context: Context) {
    try {
        const auth = await projectRouteUser(req, "memory-update", { minute: 30, day: 600 });
        if (auth.response) return auth.response;
        const { projectId, memoryId } = await context.params;
        await assertProjectMemory(auth.userId, projectId, memoryId);
        const body = await readLimitedJson(req, 8 * 1024, patchSchema);
        if (body.action === "pin") await setMemoryPinned(auth.userId, memoryId, body.pinned);
        else await editMemory({ userId: auth.userId, memoryId, statement: body.statement, expiresAt: body.expiresAt });
        return NextResponse.json({ ok: true }, { headers: NO_STORE });
    } catch (error) {
        return projectErrorResponse(error, "projects.memories.update");
    }
}

export async function DELETE(req: Request, context: Context) {
    try {
        const auth = await projectRouteUser(req, "memory-delete", { minute: 30, day: 600 });
        if (auth.response) return auth.response;
        const { projectId, memoryId } = await context.params;
        await assertProjectMemory(auth.userId, projectId, memoryId);
        return NextResponse.json(await deleteMemory(auth.userId, memoryId), { headers: NO_STORE });
    } catch (error) {
        return projectErrorResponse(error, "projects.memories.delete");
    }
}
