/**
 * Knowledge files for one profile (Release C, C2; policy §14.1, §21).
 *
 * Three verbs on one path, because they are three views of one resource:
 *
 *   GET   the owner's files, plus the capacity a picker needs *before* a file
 *         is chosen. §14.1's whole point about showing remaining quota first
 *         is defeated by an endpoint that answers only after an upload.
 *   POST  authorises an upload, or turns an uploaded object into a row. One
 *         endpoint with an `action` rather than two paths, so the pair cannot
 *         drift apart in rate limits, flag gating or ownership checks.
 *
 * `maxDuration` covers the immediate processing kick: extraction of one file
 * runs inside this budget rather than whatever the platform defaults to, for
 * the same reason the memory extraction route declares one -- a kick killed
 * mid-extraction leaves a row in `processing` that nothing recovers until the
 * ten-minute reclaim.
 */
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
import {
    AssistantProfilesDisabledError,
    isAssistantKnowledgeEnabled,
} from "@/lib/appSettings";
import { processKnowledgeFile } from "@/lib/assistantKnowledgeProcessor";
import {
    AssistantKnowledgeError,
    finalizeKnowledgeUpload,
    knowledgeCapacity,
    listKnowledgeFiles,
    prepareKnowledgeUpload,
} from "@/lib/assistantKnowledgeService";
import { authOptions } from "@/lib/auth";

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

/**
 * Both flags, resolved server-side. §15 gates knowledge on profiles being on
 * as well as on itself, and `isAssistantKnowledgeEnabled()` is where that AND
 * lives -- this route asks one question and gets the effective answer.
 */
const assertEnabled = async () => {
    if (!(await isAssistantKnowledgeEnabled())) {
        throw new AssistantProfilesDisabledError();
    }
};

const errorResponse = (error: unknown) => {
    if (error instanceof AssistantKnowledgeError) {
        return NextResponse.json(
            { error: error.message, code: error.code },
            { status: error.status, headers: { "Cache-Control": "no-store" } }
        );
    }
    if (error instanceof AssistantProfilesDisabledError) {
        return NextResponse.json(
            {
                error: "Assistant knowledge files are not enabled.",
                code: "ASSISTANT_KNOWLEDGE_DISABLED",
            },
            { status: 403, headers: { "Cache-Control": "no-store" } }
        );
    }
    return null;
};

export async function GET(
    req: Request,
    { params }: { params: Promise<{ profileId: string }> }
) {
    try {
        const session = await getServerSession(authOptions);
        const userId = session?.user?.id;
        if (!userId) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }
        await assertEnabled();
        await consumeApiRateLimit(req, userId, "assistant-knowledge-read", {
            minute: 60,
            day: 1_000,
        });

        const { profileId } = await params;
        const [files, capacity] = await Promise.all([
            listKnowledgeFiles(userId, profileId),
            knowledgeCapacity(userId, profileId),
        ]);
        return NextResponse.json(
            { files, capacity },
            { headers: { "Cache-Control": "no-store" } }
        );
    } catch (error) {
        const known = errorResponse(error);
        if (known) return known;
        const security = apiSecurityResponse(error);
        if (security) return security;
        console.error("Failed to list assistant knowledge files:", error);
        return NextResponse.json(
            { error: "Failed to load knowledge files." },
            { status: 500 }
        );
    }
}

export async function POST(
    req: Request,
    { params }: { params: Promise<{ profileId: string }> }
) {
    try {
        const session = await getServerSession(authOptions);
        const userId = session?.user?.id;
        if (!userId) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }
        await assertEnabled();
        await consumeApiRateLimit(req, userId, "assistant-knowledge-write", {
            minute: 20,
            day: 200,
        });

        const { profileId } = await params;
        const body = await readLimitedJson(req, 8 * 1024, requestSchema);

        if (body.action === "prepare") {
            const prepared = await prepareKnowledgeUpload({
                userId,
                profileId,
                filename: body.filename,
                mime: body.mime,
                bytes: body.bytes,
            });
            return NextResponse.json(prepared, {
                headers: { "Cache-Control": "no-store" },
            });
        }

        const file = await finalizeKnowledgeUpload({
            userId,
            profileId,
            uploadKey: body.uploadKey,
            filename: body.filename,
            mime: body.mime,
        });

        // Extraction starts now rather than at the next sweep. The owner is
        // looking at the screen, and a file that reads "pending" for fifteen
        // minutes reads as broken; the sweep stays as the recovery path for a
        // kick that never finished.
        after(async () => {
            await processKnowledgeFile(file.id).catch(() => undefined);
        });

        return NextResponse.json(
            {
                file: {
                    id: file.id,
                    name: file.name,
                    mime: file.mime,
                    bytes: file.bytes,
                    processingStatus: file.processingStatus,
                    createdAt: file.createdAt,
                },
            },
            { status: 201, headers: { "Cache-Control": "no-store" } }
        );
    } catch (error) {
        const known = errorResponse(error);
        if (known) return known;
        const security = apiSecurityResponse(error);
        if (security) return security;
        console.error("Assistant knowledge upload failed:", error);
        return NextResponse.json(
            { error: "Failed to store the knowledge file." },
            { status: 500 }
        );
    }
}
