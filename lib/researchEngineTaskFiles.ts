import "server-only";

import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireArtifactFormat, sanitizeArtifactFilename, type ArtifactFailureCode } from "@/lib/generatedArtifactCore";
import { ArtifactRenderError } from "@/lib/generatedArtifactRenderers";
import { discardStoredArtifacts, persistArtifactRows, putArtifactObject, type StoredArtifact } from "@/lib/generatedArtifactStorage";
import { researchInputManifestSchema, researchReportDocumentSchema, type ResearchReportDocument, type ResearchTaskOutput } from "@/lib/researchEngineContract";
import type { ReportClaim } from "@/lib/researchEngineReport";
import { lockResearchRun } from "@/lib/researchEngineStore";
import { RESEARCH_TASK_FILE_FORMATS, renderResearchTaskFile } from "@/lib/researchEngineTaskOutput";
import { researchEngineLabels, type ResearchEngineCopy } from "@/locales/researchEngine";

/**
 * The file a delegated task hands back, stored as an ordinary generated file of the run's answer message
 * (docs/policy/generated-artifacts.md: same card, download route, ownership checks and cleanup).
 *
 * One file per finished report revision, at ordinal `revision - 1`: a revision request adds the next
 * version, and a revoked private source is withheld from exactly the file made from each revision.
 * Bytes are written before the row, as for a Chat turn; the orphan sweep reclaims a crash in between.
 */

type Quality = "complete" | "partial" | "insufficient_evidence";
type RunFileOwner = { userId: string; conversationId: string; assistantMessageId: string; modelId: string };
type FailedFile = { ordinal: number; format: string; filename: string; mediaType: string; failureCode: ArtifactFailureCode; modelId: string | null };
export type PreparedResearchTaskFile = { stored: StoredArtifact } | { failed: FailedFile };

export const researchTaskFileOrdinal = (reportRevision: number) => reportRevision - 1;

const failureCodeOf = (error: unknown): ArtifactFailureCode =>
  error instanceof ArtifactRenderError && error.code === "OUTPUT_TOO_LARGE" ? "limit_exceeded" : "generation_failed";

/** Renders and stores one file; a failure becomes a failed row so the answer says no file was made. */
async function renderAndStore(owner: RunFileOwner, input: { output: ResearchTaskOutput; ordinal: number; document: ResearchReportDocument;
  claims: ReadonlyMap<string, ReportClaim>; labels: ResearchEngineCopy; quality: Quality; lineage?: { parentArtifactId: string; lineageId: string } }): Promise<PreparedResearchTaskFile> {
  const format = RESEARCH_TASK_FILE_FORMATS[input.output];
  const failed = (failureCode: ArtifactFailureCode): PreparedResearchTaskFile => ({ failed: { ordinal: input.ordinal, format,
    filename: sanitizeArtifactFilename(input.document.title, format), mediaType: requireArtifactFormat(format).mediaType, failureCode, modelId: owner.modelId } });
  let file;
  try { file = renderResearchTaskFile(input); } catch (error) { return failed(failureCodeOf(error)); }
  try {
    return { stored: await putArtifactObject({ userId: owner.userId, conversationId: owner.conversationId, ordinal: input.ordinal, format, filename: file.filename,
      mediaType: file.mediaType, bytes: file.bytes, modelId: owner.modelId, ...(input.lineage ?? {}) }) };
  } catch {
    return failed("storage_failed");
  }
}

/** Before the finalize transaction: the file for one finished revision, as the next version of the previous one. */
export async function prepareResearchTaskFile(owner: RunFileOwner, input: { output: ResearchTaskOutput; reportRevision: number;
  document: ResearchReportDocument; claims: ReadonlyMap<string, ReportClaim>; labels: ResearchEngineCopy; quality: Quality }) {
  const ordinal = researchTaskFileOrdinal(input.reportRevision);
  const parent = await prisma.messageArtifact.findFirst({ where: { messageId: owner.assistantMessageId, conversationId: owner.conversationId,
    userId: owner.userId, status: "ready", ordinal: { lt: ordinal } }, orderBy: { ordinal: "desc" }, select: { id: true, lineageId: true } });
  return renderAndStore(owner, { ...input, ordinal, ...(parent ? { lineage: { parentArtifactId: parent.id, lineageId: parent.lineageId ?? parent.id } } : {}) });
}

/** Inside the finalize transaction, after the answer message exists. Returns whether this call wrote the row. */
export async function persistResearchTaskFile(tx: Prisma.TransactionClient, owner: RunFileOwner, prepared: PreparedResearchTaskFile) {
  const written = await persistArtifactRows(tx, { messageId: owner.assistantMessageId, conversationId: owner.conversationId, userId: owner.userId,
    stored: "stored" in prepared ? [prepared.stored] : [], failed: "failed" in prepared ? [prepared.failed] : [] });
  return written > 0;
}

export async function discardResearchTaskFile(prepared: PreparedResearchTaskFile | null) {
  if (prepared && "stored" in prepared) await discardStoredArtifacts([prepared.stored]);
}

const claimMapOf = (claims: ReadonlyArray<{ claimKey: string; sectionKey: string; text: string; kind: string; verification: string; privateDerived: boolean; evidence: unknown }>) =>
  new Map<string, ReportClaim>(claims.map((claim) => [claim.claimKey, { claimKey: claim.claimKey, sectionKey: claim.sectionKey, text: claim.text,
    kind: claim.kind as ReportClaim["kind"], verification: claim.verification as ReportClaim["verification"], privateDerived: claim.privateDerived,
    evidence: claim.evidence as ReportClaim["evidence"] }]));

const contentDigest = (revision: { document: unknown; qualityStatus: string }) =>
  createHash("sha256").update(JSON.stringify([revision.document, revision.qualityStatus])).digest("hex");

/**
 * After a private source is revoked (lib/researchEngineWorker.ts withholdRevokedSources), each file is
 * rebuilt from its cleaned revision and replaces the stored bytes in place, and the old object is queued
 * for deletion in the same transaction. The file keeps its card and name, like the re-rendered chat
 * answer, but no longer carries the withdrawn content. When a clean file cannot be built the row becomes
 * a failed file instead: the old bytes are never served again. No model call, no credits.
 *
 * The swap commits only if the revision is still exactly what was rendered (checked under the run lock,
 * which every revocation also holds); otherwise it renders again from the newer revision.
 */
export async function refreshResearchTaskFiles(runId: string) {
  const run = await prisma.researchPreviewRun.findUnique({ where: { id: runId },
    select: { userId: true, conversationId: true, assistantMessageId: true, modelId: true, inputManifest: true } });
  const manifest = run ? researchInputManifestSchema.safeParse(run.inputManifest) : null;
  const output = manifest?.success ? manifest.data.brief.taskOutput : undefined;
  if (!run || !manifest?.success || !output) return 0;
  const labels = researchEngineLabels(manifest.data.brief.outputLanguage ?? manifest.data.locale);
  const files = await prisma.messageArtifact.findMany({ where: { messageId: run.assistantMessageId, conversationId: run.conversationId, userId: run.userId,
    status: "ready" }, select: { id: true, ordinal: true } });
  let replaced = 0;
  for (const file of files) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const revision = await prisma.researchReportRevision.findUnique({ where: { runId_revision: { runId, revision: file.ordinal + 1 } }, include: { claims: true } });
      if (!revision) break;
      const seen = contentDigest(revision);
      const next = await renderAndStore(run, { output, ordinal: file.ordinal, document: researchReportDocumentSchema.parse(revision.document),
        claims: claimMapOf(revision.claims), labels, quality: revision.qualityStatus as Quality });
      const outcome = await prisma.$transaction(async (tx) => {
        await lockResearchRun(tx, runId);
        const current = await tx.researchReportRevision.findUnique({ where: { id: revision.id }, select: { document: true, qualityStatus: true } });
        if (!current || contentDigest(current) !== seen) return "stale" as const;
        const row = await tx.messageArtifact.findFirst({ where: { id: file.id, status: "ready" }, select: { objectKey: true } });
        if (!row?.objectKey) return "gone" as const;
        await tx.messageArtifact.update({ where: { id: file.id }, data: "stored" in next
          ? { objectKey: next.stored.objectKey, byteSize: next.stored.byteSize, filename: next.stored.filename, mediaType: next.stored.mediaType }
          : { status: "failed", objectKey: null, byteSize: 0, failureCode: next.failed.failureCode } });
        await tx.messageArtifactCleanup.upsert({ where: { objectKey: row.objectKey }, create: { objectKey: row.objectKey, reason: "source_revoked" }, update: {} });
        return "replaced" as const;
      });
      if (outcome !== "replaced") await discardResearchTaskFile(next);
      if (outcome === "replaced") replaced += 1;
      if (outcome !== "stale") break;
    }
  }
  return replaced;
}
