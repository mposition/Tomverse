export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { z } from "zod";
import { readLimitedJson } from "@/lib/apiSecurity";
import { decodeProjectRef, readProjectSource } from "@/lib/projectSourceAccess";
import { loadOwnedProject } from "@/lib/projectWorkspaceService";
import { NO_STORE, projectErrorResponse, projectRouteUser } from "@/lib/projectRouteSupport";

/**
 * Opens one project source location (a search hit, a reference, a citation
 * from an answer receipt). Access is re-checked now; a stored ref is only an
 * address. The reply carries the location to navigate to.
 */
const schema = z.object({ ref: z.string().min(3).max(200) }).strict();

export async function POST(req: Request, context: { params: Promise<{ projectId: string }> }) {
    try {
        const auth = await projectRouteUser(req, "project-source-read", { minute: 60, day: 2_000 });
        if (auth.response) return auth.response;
        const { projectId } = await context.params;
        await loadOwnedProject(auth.userId, projectId);
        const body = await readLimitedJson(req, 1024, schema);
        const location = decodeProjectRef(body.ref);
        if (!location) return NextResponse.json({ status: "unavailable", reason: "unknown_ref" }, { status: 404, headers: NO_STORE });
        const read = await readProjectSource({ userId: auth.userId, projectId, location });
        return NextResponse.json(read, { status: read.status === "ok" ? 200 : 404, headers: NO_STORE });
    } catch (error) {
        return projectErrorResponse(error, "projects.sources.read");
    }
}
