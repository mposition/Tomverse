export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { z } from "zod";
import { readLimitedJson } from "@/lib/apiSecurity";
import { moveMemoryScope } from "@/lib/memoryService";
import { NO_STORE, projectErrorResponse, projectRouteUser } from "@/lib/projectRouteSupport";

/**
 * Explicit scope move of one memory: personal -> a project, a project ->
 * personal (the client warns that it will then be used in other
 * conversations), or between projects. A revision of the memory, never an
 * approval; conflicts in the target scope are refused, not overwritten.
 */
const schema = z.object({
    expectedRevision: z.number().int().positive(),
    targetProjectId: z.string().min(1).max(64).nullable(),
}).strict();

export async function POST(req: Request, context: { params: Promise<{ memoryId: string }> }) {
    try {
        const auth = await projectRouteUser(req, "memory-update", { minute: 30, day: 600 });
        if (auth.response) return auth.response;
        const { memoryId } = await context.params;
        const body = await readLimitedJson(req, 2 * 1024, schema);
        const result = await moveMemoryScope({
            userId: auth.userId,
            memoryId,
            expectedRevision: body.expectedRevision,
            targetProjectId: body.targetProjectId,
        });
        return NextResponse.json(result, { headers: NO_STORE });
    } catch (error) {
        return projectErrorResponse(error, "memories.scope");
    }
}
