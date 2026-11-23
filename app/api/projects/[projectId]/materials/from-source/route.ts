export const maxDuration = 120;
export const dynamic = "force-dynamic";

import { NextResponse, after } from "next/server";
import { z } from "zod";
import { readLimitedJson } from "@/lib/apiSecurity";
import { processKnowledgeFile } from "@/lib/assistantKnowledgeProcessor";
import { saveSourceAsProjectMaterial } from "@/lib/projectMaterialCopy";
import { ReviewReportSourceChanged, reviewReportSelectionSchema } from "@/lib/reviewAnalysisReportServer";
import { NO_STORE, projectErrorResponse, projectRouteUser } from "@/lib/projectRouteSupport";

/**
 * Save an owned source -- an attachment, the chosen revision of a generated
 * file, a Review analysis or a Research report -- as an independent project
 * material. The request names the source; the server reads it.
 */
const schema = z.object({
    clientRequestId: z.string().trim().min(8).max(80),
    source: z.discriminatedUnion("sourceKind", [
        z.object({ sourceKind: z.literal("message_attachment"), attachmentId: z.string().min(1).max(64) }).strict(),
        z.object({ sourceKind: z.literal("generated_artifact"), artifactId: z.string().min(1).max(64) }).strict(),
        z.object({
            sourceKind: z.literal("review_result"),
            conversationId: z.string().min(1).max(64),
            analysis: reviewReportSelectionSchema,
        }).strict(),
        z.object({ sourceKind: z.literal("research_report"), runId: z.string().min(1).max(64) }).strict(),
    ]),
}).strict();

type Context = { params: Promise<{ projectId: string }> };

export async function POST(req: Request, context: Context) {
    try {
        const auth = await projectRouteUser(req, "project-material-write", { minute: 20, day: 300 });
        if (auth.response) return auth.response;
        const { projectId } = await context.params;
        const body = await readLimitedJson(req, 4 * 1024, schema);
        const saved = await saveSourceAsProjectMaterial({
            request: req,
            userId: auth.userId,
            projectId,
            clientRequestId: body.clientRequestId,
            source: body.source,
        });
        if (saved.created) after(() => processKnowledgeFile(saved.file.id).then(() => undefined).catch(() => undefined));
        return NextResponse.json(saved, { status: saved.created ? 201 : 200, headers: NO_STORE });
    } catch (error) {
        if (error instanceof ReviewReportSourceChanged) {
            return NextResponse.json({ error: error.message, code: "REVIEW_REPORT_SOURCE_CHANGED" }, { status: 409, headers: NO_STORE });
        }
        return projectErrorResponse(error, "projects.materials.from_source");
    }
}
