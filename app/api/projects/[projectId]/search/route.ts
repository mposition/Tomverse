export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { z } from "zod";
import { readLimitedJson } from "@/lib/apiSecurity";
import { searchProjectSources } from "@/lib/projectSourceAccess";
import { loadOwnedProject } from "@/lib/projectWorkspaceService";
import { NO_STORE, projectErrorResponse, projectRouteUser } from "@/lib/projectRouteSupport";

/**
 * The person's project search: the same access path the model's
 * project_search uses -- the project applied inside every query, locked
 * conversations never searched, and partial results reported as partial.
 */
const schema = z.object({ query: z.string().trim().min(1).max(200) }).strict();

export async function POST(req: Request, context: { params: Promise<{ projectId: string }> }) {
    try {
        const auth = await projectRouteUser(req, "project-search", { minute: 30, day: 1_000 });
        if (auth.response) return auth.response;
        const { projectId } = await context.params;
        await loadOwnedProject(auth.userId, projectId);
        const body = await readLimitedJson(req, 2 * 1024, schema);
        const answer = await searchProjectSources({ userId: auth.userId, projectId, query: body.query, requestUrl: req.url });
        return NextResponse.json(answer, { headers: NO_STORE });
    } catch (error) {
        return projectErrorResponse(error, "projects.search");
    }
}
