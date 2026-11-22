export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { z } from "zod";
import { readLimitedJson } from "@/lib/apiSecurity";
import {
    deleteProject,
    getProjectDetail,
    projectDeletionSummary,
    updateProject,
} from "@/lib/projectWorkspaceService";
import { PROJECT_LIMITS, PROJECT_MEMORY_SCOPES } from "@/lib/projectWorkspaceCore";
import { NO_STORE, projectErrorResponse, projectRouteUser } from "@/lib/projectRouteSupport";

type ProjectRouteContext = { params: Promise<{ projectId: string }> };

const updateProjectSchema = z
    .object({
        name: z.string().trim().min(1).max(PROJECT_LIMITS.maxNameLength).optional(),
        description: z.string().max(PROJECT_LIMITS.maxDescriptionLength).optional(),
        instructions: z.string().max(PROJECT_LIMITS.maxInstructionsLength).optional(),
        contextEnabled: z.boolean().optional(),
        memoryScope: z.enum(PROJECT_MEMORY_SCOPES).optional(),
        autoMemoryEnabled: z.boolean().optional(),
        archived: z.boolean().optional(),
        expectedRevision: z.number().int().positive().optional(),
    })
    .strict();

const deleteSchema = z
    .object({
        confirmation: z
            .object({
                revision: z.number().int().positive(),
                materials: z.number().int().min(0),
                memories: z.number().int().min(0),
            })
            .strict()
            .optional(),
    })
    .strict();

export async function GET(req: Request, context: ProjectRouteContext) {
    try {
        const auth = await projectRouteUser(req, "project-read", { minute: 120, day: 10_000 });
        if (auth.response) return auth.response;
        const { projectId } = await context.params;
        const url = new URL(req.url);
        if (url.searchParams.get("view") === "deletion") {
            return NextResponse.json({ deletion: await projectDeletionSummary(auth.userId, projectId) }, { headers: NO_STORE });
        }
        return NextResponse.json(await getProjectDetail(auth.userId, projectId), { headers: NO_STORE });
    } catch (error) {
        return projectErrorResponse(error, "projects.read");
    }
}

export async function PATCH(req: Request, context: ProjectRouteContext) {
    try {
        const auth = await projectRouteUser(req, "project-update", { minute: 20, day: 300 });
        if (auth.response) return auth.response;
        const { projectId } = await context.params;
        const body = await readLimitedJson(req, 40 * 1024, updateProjectSchema);
        return NextResponse.json(await updateProject(auth.userId, projectId, body), { headers: NO_STORE });
    } catch (error) {
        return projectErrorResponse(error, "projects.update");
    }
}

/**
 * Conversations always stay (they leave the project); the project's own
 * materials and memories are deleted. A project holding any of those needs a
 * confirmation echoing the summary the user saw (`?view=deletion`), so the
 * folder-era bare DELETE gets 409 instead of quietly deleting them.
 */
export async function DELETE(req: Request, context: ProjectRouteContext) {
    try {
        const auth = await projectRouteUser(req, "project-delete", { minute: 10, day: 100 });
        if (auth.response) return auth.response;
        const { projectId } = await context.params;
        const raw = await req.text();
        if (raw.length > 4 * 1024) return NextResponse.json({ error: "Request too large." }, { status: 413, headers: NO_STORE });
        const body = raw.trim() ? deleteSchema.parse(JSON.parse(raw)) : {};
        const result = await deleteProject(auth.userId, projectId, body.confirmation);
        return NextResponse.json({ success: true, ...result }, { headers: NO_STORE });
    } catch (error) {
        return projectErrorResponse(error, "projects.delete");
    }
}
