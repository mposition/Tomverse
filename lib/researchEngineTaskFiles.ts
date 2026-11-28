import "server-only";

import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireArtifactFormat, sanitizeArtifactFilename, type ArtifactFailureCode } from "@/lib/generatedArtifactCore";
import { discardStoredArtifacts, persistArtifactRows, putArtifactObject, type StoredArtifact } from "@/lib/generatedArtifactStorage";
import { researchInputManifestSchema, researchReportDocumentSchema, type ResearchReportDocument, type ResearchTaskOutput } from "@/lib/researchEngineContract";
import type { ReportClaim } from "@/lib/researchEngineReport";
import { lockResearchRun } from "@/lib/researchEngineStore";
import { RESEARCH_TASK_FILE_FORMATS, ResearchTaskFileOverflowError, renderResearchTaskFile } from "@/lib/researchEngineTaskOutput";
import { researchEngineLabels, type ResearchEngineCopy } from "@/locales/researchEngine";

/**
 * The file a delegated task hands back, stored as an ordinary generated file of the run's answer message
 * (docs/policy/generated-artifacts.md: same card, download route, ownership checks and cleanup).
 *
 * One file per finished report revision, at ordinal `revision - 1`: a revision request adds the next
 * version, and a revoked private source is withheld from exactly the file made from each revision.
 * Bytes are written before the row, as for a Chat turn; the orphan sweep reclaims a crash in between.
 *
 * A file made from private sources is a copy of the report, so it follows the report's revocation rule
 * (docs/ops/research-engine-v2.md section 3): the transaction that withholds report content also withholds
 * the files (`source_revoked`, nothing served, old bytes queued for deletion); the file is rebuilt from the
 * cleaned revision afterwards, and a rebuild that fails or is interrupted stays `source_revoked` until the
 * next read or maintenance pass rebuilds it.
 */

type Quality = "complete" | "partial" | "insufficient_evidence";
type RunFileOwner = { userId: string; conversationId: string; assistantMessageId: string; modelId: string };
type FailedFile = { ordinal: number; format: string; filename: string; mediaType: string; failureCode: ArtifactFailureCode; modelId: string | null };
export type PreparedResearchTaskFile = { stored: StoredArtifact } | { failed: FailedFile };

/** Withheld after a private source was revoked, and waiting to be rebuilt: the retry target. */
export const RESEARCH_TASK_FILE_WITHHELD = "source_revoked" satisfies ArtifactFailureCode;

export const researchTaskFileOrdinal = (reportRevision: number) => reportRevision - 1;

const failureCodeOf = (error: unknown): ArtifactFailureCode =>
  error instanceof ResearchTaskFileOverflowError ? "content_too_large" : "generation_failed";

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

/**
 * Inside the transaction that withholds revoked content (under the run lock): from its commit no byte of
 * the run's files is served. Each ready file, or only those made from `revisions`, becomes `source_revoked`
 * with no object, and the old object is queued for deletion in the same transaction.
 */
export async function withholdResearchTaskFiles(tx: Prisma.TransactionClient, runId: string, revisions?: ReadonlySet<number>) {
  const run = await tx.researchPreviewRun.findUnique({ where: { id: runId }, select: { userId: true, conversationId: true, assistantMessageId: true } });
  if (!run) return 0;
  const files = (await tx.messageArtifact.findMany({ where: { messageId: run.assistantMessageId, conversationId: run.conversationId, userId: run.userId,
    message: { researchRunId: runId }, status: "ready", objectKey: { not: null } }, select: { id: true, ordinal: true, objectKey: true } }))
    .filter((file) => !revisions || revisions.has(file.ordinal + 1));
  for (const file of files) {
    await tx.messageArtifact.update({ where: { id: file.id }, data: { status: "failed", objectKey: null, byteSize: 0, failureCode: RESEARCH_TASK_FILE_WITHHELD } });
    await tx.messageArtifactCleanup.upsert({ where: { objectKey: file.objectKey! }, create: { objectKey: file.objectKey!, reason: "source_revoked" }, update: {} });
  }
  return files.length;
}

const claimMapOf = (claims: ReadonlyArray<{ claimKey: string; sectionKey: string; text: string; kind: string; verification: string; privateDerived: boolean; evidence: unknown }>) =>
  new Map<string, ReportClaim>(claims.map((claim) => [claim.claimKey, { claimKey: claim.claimKey, sectionKey: claim.sectionKey, text: claim.text,
    kind: claim.kind as ReportClaim["kind"], verification: claim.verification as ReportClaim["verification"], privateDerived: claim.privateDerived,
    evidence: claim.evidence as ReportClaim["evidence"] }]));

const contentDigest = (revision: { document: unknown; qualityStatus: string }) =>
  createHash("sha256").update(JSON.stringify([revision.document, revision.qualityStatus])).digest("hex");

/**
 * Rebuilds every withheld file of a run from its cleaned revision. A rebuilt file becomes ready again in
 * place (same card and id, new bytes). The swap commits only if the revision is still exactly what was
 * rendered and the file is still withheld (checked under the run lock, which every withholding holds);
 * otherwise it renders again. A report that no longer fits the file kind ends as a failed file; a storage
 * failure leaves it withheld for the next read or maintenance pass. No model call, no credits.
 */
export async function rebuildWithheldResearchTaskFiles(runId: string) {
  const run = await prisma.researchPreviewRun.findUnique({ where: { id: runId },
    select: { userId: true, conversationId: true, assistantMessageId: true, modelId: true, inputManifest: true } });
  const manifest = run ? researchInputManifestSchema.safeParse(run.inputManifest) : null;
  const output = manifest?.success ? manifest.data.brief.taskOutput : undefined;
  if (!run || !manifest?.success || !output) return 0;
  const labels = researchEngineLabels(manifest.data.brief.outputLanguage ?? manifest.data.locale);
  const files = await prisma.messageArtifact.findMany({ where: { messageId: run.assistantMessageId, conversationId: run.conversationId, userId: run.userId,
    message: { researchRunId: runId }, status: "failed", failureCode: RESEARCH_TASK_FILE_WITHHELD }, select: { id: true, ordinal: true } });
  let rebuilt = 0;
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
        const row = await tx.messageArtifact.findFirst({ where: { id: file.id, status: "failed", failureCode: RESEARCH_TASK_FILE_WITHHELD }, select: { id: true } });
        if (!row) return "gone" as const;
        if ("stored" in next) {
          await tx.messageArtifact.update({ where: { id: file.id }, data: { status: "ready", objectKey: next.stored.objectKey, byteSize: next.stored.byteSize,
            filename: next.stored.filename, mediaType: next.stored.mediaType, failureCode: null } });
          return "rebuilt" as const;
        }
        // Storage can recover; a report that does not fit or cannot be laid out will not.
        if (next.failed.failureCode === "storage_failed") return "later" as const;
        await tx.messageArtifact.update({ where: { id: file.id }, data: { filename: next.failed.filename, failureCode: next.failed.failureCode } });
        return "failed" as const;
      });
      if (outcome !== "rebuilt") await discardResearchTaskFile(next);
      if (outcome === "rebuilt") rebuilt += 1;
      if (outcome !== "stale") break;
    }
  }
  return rebuilt;
}

/**
 * Before any byte of a generated file is served or copied (download, revision input, project material).
 * A file made by a Research run that selected private sources is served only while those sources still
 * grant it: the same re-check the Research reads and exports make (revalidateRunPrivateSources). A source
 * found revoked withholds the run's files in its own transaction and starts the rebuild, and this file is
 * refused; it is served again once rebuilt. Every other file costs one indexed read.
 */
export async function researchTaskFileServable(artifact: { id: string; objectKey: string }) {
  const row = await prisma.messageArtifact.findUnique({ where: { id: artifact.id }, select: { message: { select: { researchRunId: true } } } });
  const runId = row?.message.researchRunId;
  if (!runId) return true;
  const run = await prisma.researchPreviewRun.findUnique({ where: { id: runId }, select: { id: true, userId: true, inputManifest: true, engineVersion: true } });
  if (!run || run.engineVersion !== 2 || !(await prisma.researchSource.count({ where: { runId, visibility: "private" } }))) return true;
  const { revalidateRunPrivateSources } = await import("@/lib/researchEngineReads");
  await revalidateRunPrivateSources(run);
  const current = await prisma.messageArtifact.findUnique({ where: { id: artifact.id }, select: { status: true, objectKey: true } });
  return current?.status === "ready" && current.objectKey === artifact.objectKey;
}
