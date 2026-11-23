export const maxDuration = 120;
export const dynamic = "force-dynamic";

import { NextResponse, after } from "next/server";
import { z } from "zod";
import { readLimitedJson } from "@/lib/apiSecurity";
import { processKnowledgeFile } from "@/lib/assistantKnowledgeProcessor";
import {
    finalizeKnowledgeUpload,
    knowledgeCapacity,
    listKnowledgeFiles,
    prepareKnowledgeUpload,
    type KnowledgeContainer,
} from "@/lib/assistantKnowledgeService";
import { saveSourceAsProjectMaterial } from "@/lib/projectMaterialCopy";
import { PROJECT_LIMITS } from "@/lib/projectWorkspaceCore";
import { NO_STORE, projectErrorResponse, projectRouteUser } from "@/lib/projectRouteSupport";

/**
 * Project materials: the assistant-knowledge upload, processing and storage
 * pipeline with a project as the owner container. prepare/finalize for files,
 * `note` for a text note. Quotas are the account's, shared with assistant
 * knowledge; a project adds no second budget.
 */
const requestSchema = z.discriminatedUnion("action", [
    z.object({
        action: z.literal("prepare"),
        filename: z.string().trim().min(1).max(200),
        mime: z.string().trim().min(1).max(160),
        bytes: z.number().int().positive(),
    }).strict(),
    z.object({
        action: z.literal("finalize"),
        uploadKey: z.string().trim().min(1).max(200),
        filename: z.string().trim().min(1).max(200),
        mime: z.string().trim().min(1).max(160),
    }).strict(),
    z.object({
        action: z.literal("note"),
        clientRequestId: z.string().trim().min(8).max(80),
        title: z.string().trim().min(1).max(160),
        text: z.string().min(1).max(PROJECT_LIMITS.maxNoteCharacters),
    }).strict(),
]);

type Context = { params: Promise<{ projectId: string }> };

export async function GET(req: Request, context: Context) {
    try {
        const auth = await projectRouteUser(req, "project-material-read", { minute: 60, day: 2_000 });
        if (auth.response) return auth.response;
        const { projectId } = await context.params;
        const container: KnowledgeContainer = { kind: "project", projectId };
        const [files, capacity] = await Promise.all([
            listKnowledgeFiles(auth.userId, container),
            knowledgeCapacity(auth.userId, container),
        ]);
        return NextResponse.json({ files, capacity }, { headers: NO_STORE });
    } catch (error) {
        return projectErrorResponse(error, "projects.materials.list");
    }
}

export async function POST(req: Request, context: Context) {
    try {
        const auth = await projectRouteUser(req, "project-material-write", { minute: 20, day: 300 });
        if (auth.response) return auth.response;
        const { projectId } = await context.params;
        const container: KnowledgeContainer = { kind: "project", projectId };
        const body = await readLimitedJson(req, PROJECT_LIMITS.maxNoteCharacters * 4 + 4096, requestSchema);
        if (body.action === "prepare") {
            const prepared = await prepareKnowledgeUpload({
                userId: auth.userId,
                container,
                filename: body.filename,
                mime: body.mime,
                bytes: body.bytes,
            });
            return NextResponse.json(prepared, { headers: NO_STORE });
        }
        if (body.action === "finalize") {
            const file = await finalizeKnowledgeUpload({
                userId: auth.userId,
                container,
                uploadKey: body.uploadKey,
                filename: body.filename,
                mime: body.mime,
            });
            after(() => processKnowledgeFile(file.id).then(() => undefined).catch(() => undefined));
            return NextResponse.json({ file: { id: file.id, name: file.name, processingStatus: file.processingStatus } }, { status: 201, headers: NO_STORE });
        }
        const saved = await saveSourceAsProjectMaterial({
            request: req,
            userId: auth.userId,
            projectId,
            clientRequestId: body.clientRequestId,
            source: { sourceKind: "note", title: body.title, text: body.text },
        });
        if (saved.created) after(() => processKnowledgeFile(saved.file.id).then(() => undefined).catch(() => undefined));
        return NextResponse.json(saved, { status: saved.created ? 201 : 200, headers: NO_STORE });
    } catch (error) {
        return projectErrorResponse(error, "projects.materials.write");
    }
}
