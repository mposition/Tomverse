import "server-only";

import { createHash } from "node:crypto";
import type { z } from "zod";
import { ApiSecurityError } from "@/lib/apiSecurity";
import { ASSISTANT_KNOWLEDGE_TYPES } from "@/lib/assistantKnowledgeLimits";
import { createProjectKnowledgeFileFromBytes, type ProjectCopySourceKind } from "@/lib/assistantKnowledgeService";
import { hasConversationUnlockGrant } from "@/lib/conversationLock";
import { prisma } from "@/lib/prisma";
import { materialRequestKey, type ProjectMaterialSourceRef } from "@/lib/projectWorkspaceCore";
import { readOwnR2ObjectBytes } from "@/lib/r2";
import { loadReviewAnalysisReport, type reviewReportSelectionSchema } from "@/lib/reviewAnalysisReportServer";

/**
 * "Save to project materials": the server reads an owned source itself and
 * stores an independent copy the project owns.
 *
 * The request names a source by kind and id (and, for a generated file, the
 * exact revision the user chose); it never carries the content, a URL or a
 * storage key. Ownership, the conversation lock and (for a generated file)
 * the revision are checked here, and the provenance written on the copy is
 * the server's own record. Retrying the same request in the same project
 * returns the same copy; the same request in another project is a new copy
 * there. A later change to the source never rewrites the copy.
 */

export type MaterialCopyRequest =
    | { sourceKind: "message_attachment"; attachmentId: string }
    | { sourceKind: "generated_artifact"; artifactId: string }
    | { sourceKind: "review_result"; conversationId: string; analysis: z.infer<typeof reviewReportSelectionSchema> }
    | { sourceKind: "research_report"; runId: string }
    | { sourceKind: "note"; title: string; text: string };

const MAX_COPY_BYTES = 32 * 1024 * 1024;

const supportedMime = (mime: string) => Object.prototype.hasOwnProperty.call(ASSISTANT_KNOWLEDGE_TYPES, mime);
const digestOf = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

const lockedOrMissing = () => new ApiSecurityError(404, "MATERIAL_SOURCE_NOT_FOUND", "The source is not available.");

async function assertConversationReadable(request: Request, userId: string, conversationId: string) {
    const conversation = await prisma.conversation.findFirst({
        where: { id: conversationId, userId },
        select: { password: true, passwordVersion: true },
    });
    if (!conversation) throw lockedOrMissing();
    if (!hasConversationUnlockGrant(request, userId, conversationId, conversation.password == null ? null : conversation.passwordVersion)) {
        throw new ApiSecurityError(423, "CONVERSATION_LOCKED", "Unlock the conversation first.");
    }
}

async function readSource(request: Request, userId: string, source: MaterialCopyRequest): Promise<{
    name: string;
    mime: string;
    bytes: Buffer;
    sourceKind: ProjectCopySourceKind;
    sourceRef: ProjectMaterialSourceRef | null;
    sourceId: string;
    revision: number | null;
}> {
    switch (source.sourceKind) {
        case "note": {
            const text = source.text.normalize("NFC");
            const bytes = Buffer.from(text, "utf8");
            return {
                name: `${source.title.trim().slice(0, 160) || "Note"}.md`,
                mime: "text/markdown",
                bytes,
                sourceKind: "note",
                sourceRef: null,
                sourceId: digestOf(bytes),
                revision: null,
            };
        }
        case "message_attachment": {
            const row = await prisma.messageAttachment.findFirst({
                where: { id: source.attachmentId, userId, unavailableAt: null },
                select: { id: true, name: true, mediaType: true, objectKey: true, conversationId: true, size: true },
            });
            if (!row) throw lockedOrMissing();
            await assertConversationReadable(request, userId, row.conversationId);
            if (!supportedMime(row.mediaType)) {
                throw new ApiSecurityError(422, "ASSISTANT_KNOWLEDGE_UNSUPPORTED_FILE", "This file type cannot be saved as a project material.");
            }
            const bytes = await readOwnR2ObjectBytes(row.objectKey, { maxBytes: MAX_COPY_BYTES });
            return {
                name: row.name,
                mime: row.mediaType,
                bytes,
                sourceKind: "message_attachment",
                sourceRef: { kind: "message_attachment", attachmentId: row.id, conversationId: row.conversationId, digest: digestOf(bytes) },
                sourceId: row.id,
                revision: null,
            };
        }
        case "generated_artifact": {
            // The exact revision row the user chose -- never "the latest".
            const row = await prisma.messageArtifact.findFirst({
                where: { id: source.artifactId, userId, status: "ready", objectKey: { not: null } },
                select: { id: true, filename: true, mediaType: true, objectKey: true, conversationId: true, lineageId: true, createdAt: true },
            });
            if (!row || !row.objectKey) throw lockedOrMissing();
            await assertConversationReadable(request, userId, row.conversationId);
            if (!supportedMime(row.mediaType)) {
                throw new ApiSecurityError(422, "ASSISTANT_KNOWLEDGE_UNSUPPORTED_FILE", "This file type cannot be saved as a project material.");
            }
            // A Research task file made from private sources is copied only while those sources still grant it.
            if (!(await (await import("@/lib/researchEngineTaskFiles")).researchTaskFileServable({ id: row.id, objectKey: row.objectKey }))) throw lockedOrMissing();
            const revision = row.lineageId
                ? await prisma.messageArtifact.count({
                      where: { userId, lineageId: row.lineageId, createdAt: { lte: row.createdAt } },
                  })
                : 1;
            const bytes = await readOwnR2ObjectBytes(row.objectKey, { maxBytes: MAX_COPY_BYTES });
            return {
                name: row.filename,
                mime: row.mediaType,
                bytes,
                sourceKind: "generated_artifact",
                sourceRef: { kind: "generated_artifact", artifactId: row.id, revision, conversationId: row.conversationId, digest: digestOf(bytes) },
                sourceId: row.id,
                revision,
            };
        }
        case "review_result": {
            await assertConversationReadable(request, userId, source.conversationId);
            const { report, stored } = await loadReviewAnalysisReport(userId, source.conversationId, source.analysis);
            const bytes = Buffer.from(report.text, "utf8");
            return {
                name: `${report.title.slice(0, 160) || "Review"}.md`,
                mime: "text/markdown",
                bytes,
                sourceKind: "review_result",
                sourceRef: { kind: "review_result", messageId: stored.id, conversationId: source.conversationId, digest: digestOf(bytes) },
                sourceId: `${stored.id}:${source.analysis.reviewer}:${source.analysis.fingerprint}`,
                revision: null,
            };
        }
        case "research_report": {
            const run = await prisma.researchPreviewRun.findFirst({
                where: { id: source.runId, userId, status: "completed" },
                select: { id: true, conversationId: true, assistantMessageId: true },
            });
            if (!run) throw lockedOrMissing();
            await assertConversationReadable(request, userId, run.conversationId);
            const message = await prisma.message.findFirst({
                where: { id: run.assistantMessageId, conversationId: run.conversationId, role: "assistant" },
                select: { content: true },
            });
            if (!message || !message.content.trim()) throw lockedOrMissing();
            const bytes = Buffer.from(message.content, "utf8");
            return {
                name: "Research report.md",
                mime: "text/markdown",
                bytes,
                sourceKind: "research_report",
                sourceRef: { kind: "research_report", runId: run.id, conversationId: run.conversationId, digest: digestOf(bytes) },
                sourceId: run.id,
                revision: null,
            };
        }
    }
}

export async function saveSourceAsProjectMaterial(input: {
    request: Request;
    userId: string;
    projectId: string;
    clientRequestId: string;
    source: MaterialCopyRequest;
}) {
    const read = await readSource(input.request, input.userId, input.source);
    const requestKey = materialRequestKey({
        clientRequestId: input.clientRequestId,
        sourceKind: read.sourceKind,
        sourceId: read.sourceId,
        revision: read.revision,
    });
    const { file, created } = await createProjectKnowledgeFileFromBytes({
        userId: input.userId,
        projectId: input.projectId,
        name: read.name,
        mime: read.mime,
        bytes: read.bytes,
        sourceKind: read.sourceKind,
        sourceRef: read.sourceRef,
        requestKey,
    });
    return {
        created,
        file: {
            id: file.id,
            name: file.name,
            mime: file.mime,
            bytes: file.bytes,
            processingStatus: file.processingStatus,
            sourceKind: file.sourceKind,
            sourceRef: file.sourceRef,
        },
    };
}
