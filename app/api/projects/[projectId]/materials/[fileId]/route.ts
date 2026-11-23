export const maxDuration = 120;
export const dynamic = "force-dynamic";

import { NextResponse, after } from "next/server";
import { z } from "zod";
import { readLimitedJson } from "@/lib/apiSecurity";
import { processKnowledgeFile } from "@/lib/assistantKnowledgeProcessor";
import { deleteKnowledgeFile, knowledgeFileReadUrl, retryKnowledgeFile } from "@/lib/assistantKnowledgeService";
import { NO_STORE, projectErrorResponse, projectRouteUser } from "@/lib/projectRouteSupport";

type Context = { params: Promise<{ projectId: string; fileId: string }> };

/** A short-lived download link for the owner's own material. */
export async function GET(req: Request, context: Context) {
    try {
        const auth = await projectRouteUser(req, "project-material-read", { minute: 60, day: 2_000 });
        if (auth.response) return auth.response;
        const { projectId, fileId } = await context.params;
        const link = await knowledgeFileReadUrl({ userId: auth.userId, container: { kind: "project", projectId }, fileId });
        return NextResponse.json(link, { headers: NO_STORE });
    } catch (error) {
        return projectErrorResponse(error, "projects.materials.read");
    }
}

const actionSchema = z.object({ action: z.literal("retry") }).strict();

/** Retry a failed material. */
export async function POST(req: Request, context: Context) {
    try {
        const auth = await projectRouteUser(req, "project-material-write", { minute: 20, day: 300 });
        if (auth.response) return auth.response;
        const { projectId, fileId } = await context.params;
        await readLimitedJson(req, 1024, actionSchema);
        const result = await retryKnowledgeFile({ userId: auth.userId, container: { kind: "project", projectId }, fileId });
        after(() => processKnowledgeFile(fileId).then(() => undefined).catch(() => undefined));
        return NextResponse.json(result, { headers: NO_STORE });
    } catch (error) {
        return projectErrorResponse(error, "projects.materials.retry");
    }
}

export async function DELETE(req: Request, context: Context) {
    try {
        const auth = await projectRouteUser(req, "project-material-write", { minute: 20, day: 300 });
        if (auth.response) return auth.response;
        const { projectId, fileId } = await context.params;
        const result = await deleteKnowledgeFile({ userId: auth.userId, container: { kind: "project", projectId }, fileId });
        return NextResponse.json(result, { headers: NO_STORE });
    } catch (error) {
        return projectErrorResponse(error, "projects.materials.delete");
    }
}
