export const maxDuration = 120;
export const dynamic = "force-dynamic";

import { NextResponse, after } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";

import {
    apiSecurityResponse,
    consumeApiRateLimit,
    readLimitedJson,
} from "@/lib/apiSecurity";
import { processKnowledgeFile } from "@/lib/assistantKnowledgeProcessor";
import {
    assertImportEnabled,
    importErrorResponse,
} from "@/lib/assistantProfileImportHttp";
import {
    finalizeImportKnowledgeUpload,
    prepareImportKnowledgeUpload,
} from "@/lib/assistantProfileImportService";
import { authOptions } from "@/lib/auth";

/**
 * Documents for one import.
 *
 * docs/policy/assistant-package-import.md §5.6.
 *
 * A separate path from the profile's own knowledge endpoint, and not a flag on
 * it. That endpoint's request shapes are `.strict()` and carry no import, and
 * the row it creates has no import holding it -- so a file uploaded through it
 * is an ordinary file the moment it exists, visible to the editor and
 * publishable. Adding a field to that request would have made the isolation
 * depend on the client remembering to set it.
 *
 * `importId` comes from the URL and the profile comes from the import row.
 * Neither is in the body, because a body that named them would be a body that
 * could name somebody else's.
 */

const requestSchema = z.discriminatedUnion("action", [
    z
        .object({
            action: z.literal("prepare"),
            filename: z.string().trim().min(1).max(200),
            mime: z.string().trim().min(1).max(160),
            bytes: z.number().int().positive(),
        })
        .strict(),
    z
        .object({
            action: z.literal("finalize"),
            uploadKey: z.string().trim().min(1).max(200),
            filename: z.string().trim().min(1).max(200),
            mime: z.string().trim().min(1).max(160),
        })
        .strict(),
]);

export async function POST(
    req: Request,
    { params }: { params: Promise<{ importId: string }> }
) {
    try {
        const session = await getServerSession(authOptions);
        const userId = session?.user?.id;
        if (!userId) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }
        await assertImportEnabled();
        await consumeApiRateLimit(req, userId, "assistant-knowledge-write", {
            minute: 20,
            day: 200,
        });

        const { importId } = await params;
        const body = await readLimitedJson(req, 8 * 1024, requestSchema);

        if (body.action === "prepare") {
            const prepared = await prepareImportKnowledgeUpload({
                userId,
                importId,
                filename: body.filename,
                mime: body.mime,
                bytes: body.bytes,
            });
            return NextResponse.json(prepared, {
                headers: { "Cache-Control": "no-store" },
            });
        }

        const file = await finalizeImportKnowledgeUpload({
            userId,
            importId,
            uploadKey: body.uploadKey,
            filename: body.filename,
            mime: body.mime,
        });

        // Extraction starts now rather than at the next sweep, for the same
        // reason the ordinary path kicks it: the owner is watching step 7, and
        // a document that reads "pending" for fifteen minutes reads as broken.
        // The sweep remains the recovery path for a kick that never finished.
        after(async () => {
            await processKnowledgeFile(file.id).catch((error) => {
                console.error("Import knowledge processing failed:", error);
            });
        });

        return NextResponse.json(
            {
                id: file.id,
                name: file.name,
                mime: file.mime,
                bytes: file.bytes,
                processingStatus: file.processingStatus,
            },
            { headers: { "Cache-Control": "no-store" } }
        );
    } catch (error) {
        const known = importErrorResponse(error);
        if (known) return known;
        const security = apiSecurityResponse(error);
        if (security) return security;
        console.error("Failed to stage a document for an import:", error);
        return NextResponse.json(
            { error: "Failed to add the document." },
            { status: 500 }
        );
    }
}
