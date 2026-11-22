export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { z } from "zod";
import { readLimitedJson } from "@/lib/apiSecurity";
import { createProject, listProjects } from "@/lib/projectWorkspaceService";
import { PROJECT_LIMITS, PROJECT_MEMORY_SCOPES } from "@/lib/projectWorkspaceCore";
import { NO_STORE, projectErrorResponse, projectRouteUser } from "@/lib/projectRouteSupport";

/**
 * Project list and create. A create that sends only a name is the
 * folder-era call and still makes a folder (context off); the workspace
 * create screen sends its context choices explicitly.
 */
const createProjectSchema = z
    .object({
        name: z.string().trim().min(1).max(PROJECT_LIMITS.maxNameLength),
        description: z.string().max(PROJECT_LIMITS.maxDescriptionLength).optional(),
        instructions: z.string().max(PROJECT_LIMITS.maxInstructionsLength).optional(),
        contextEnabled: z.boolean().optional(),
        memoryScope: z.enum(PROJECT_MEMORY_SCOPES).optional(),
        autoMemoryEnabled: z.boolean().optional(),
    })
    .strict();

export async function GET(req: Request) {
    try {
        const auth = await projectRouteUser(req, "project-list", { minute: 60, day: 5_000 });
        if (auth.response) return auth.response;
        return NextResponse.json({ projects: await listProjects(auth.userId) }, { headers: NO_STORE });
    } catch (error) {
        return projectErrorResponse(error, "projects.list");
    }
}

export async function POST(req: Request) {
    try {
        const auth = await projectRouteUser(req, "project-create", { minute: 10, day: 100 });
        if (auth.response) return auth.response;
        const body = await readLimitedJson(req, 40 * 1024, createProjectSchema);
        const project = await createProject(auth.userId, body);
        return NextResponse.json(project, { status: 201, headers: NO_STORE });
    } catch (error) {
        return projectErrorResponse(error, "projects.create");
    }
}
