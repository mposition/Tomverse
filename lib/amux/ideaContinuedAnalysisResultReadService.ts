import "server-only";

import { Prisma, type AmuxIdeaAnalysisChunk } from "@prisma/client";
import type { Session } from "next-auth";

import { auditRowActorKind, AMUX_V4_FIRST_DRAFT_SAVED_ACTION,
  AMUX_V4_FIRST_DRAFT_SAVED_TARGET, AMUX_V4_SECOND_DRAFT_SAVED_ACTION,
  AMUX_V4_SECOND_DRAFT_SAVED_TARGET } from "@/lib/adminAuditSystemActors";
import { prisma } from "@/lib/prisma";
import { amuxAnalysisTextSafe, inspectAmuxStoredAnalysisUnit } from
  "./ideaAnalysisChunkCore.ts";
import { amuxAnalysisFreeformSubjectId } from "./ideaAnalysisDraftSealCore.ts";
import { readAmuxFirstIdeaAnalysisResultInTransaction,
  AmuxIdeaAnalysisResultReadError } from "./ideaAnalysisResultReadService.ts";
import { matchesAmuxIdeaAnalysisCursorAudit,
  matchesAmuxIdeaAnalysisUnitCommitments } from "./ideaAnalysisResultReadCore.ts";
import type { AmuxIdeaAnalysisResultPage, AmuxIdeaAnalysisResultView,
  AmuxVisibleAnalysisUnit } from "./ideaAnalysisResultReadCore.ts";
import { openAmuxContent, verifyAmuxContentDigest,
  type AmuxContentKeys } from "./ideaCrypto.ts";

/** Owner-only consistent read of the first two bounded pages. A completed
 * continuation is not represented as a completed first page: each stored page
 * keeps its own audit, digest, expiry and independently purgeable unit bodies. */
export async function readAmuxIdeaAnalysisResult(
  session: Session, ideaId: string, keys: AmuxContentKeys,
): Promise<AmuxIdeaAnalysisResultView> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT set_config('statement_timeout', '3000', true) AS statement_limit,
             set_config('idle_in_transaction_session_timeout', '6000', true) AS idle_limit
    `;
    return readAmuxIdeaAnalysisResultInTransaction(tx, session, ideaId, keys);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    maxWait: 2_000, timeout: 10_000 });
}

/** Shared transaction body for owner read-back and atomic writer tests. */
export async function readAmuxIdeaAnalysisResultInTransaction(
  tx: Prisma.TransactionClient, session: Session, ideaId: string,
  keys: AmuxContentKeys,
): Promise<AmuxIdeaAnalysisResultView> {
    const first = await readAmuxFirstIdeaAnalysisResultInTransaction(
      tx, session, ideaId, keys);
    if (first.state !== "partial") return first;
    const idea = await tx.amuxIdeaSubmission.findUnique({ where: { id: ideaId } });
    const firstChunk = await tx.amuxIdeaAnalysisChunk.findUnique({
      where: { ideaId_chunkIndex: { ideaId, chunkIndex: 0 } },
    });
    const chunk = await tx.amuxIdeaAnalysisChunk.findUnique({
      where: { ideaId_chunkIndex: { ideaId, chunkIndex: 1 } },
    });
    if (!idea || idea.actorUserId !== session.user?.id || !firstChunk || !chunk ||
        firstChunk.currentPreviewId !== first.previewId) {
      throw new AmuxIdeaAnalysisResultReadError("integrity_unavailable");
    }
    if (chunk.state !== "draft_ready") {
      if (idea.state === "analyzing") return first;
      throw new AmuxIdeaAnalysisResultReadError("integrity_unavailable");
    }
    const partial = idea.state === "analyzing" && idea.analysisCompletedAt === null;
    if (!partial && (idea.state !== "awaiting_owner" || !idea.analysisCompletedAt)) {
      throw new AmuxIdeaAnalysisResultReadError("integrity_unavailable");
    }
    const page = await readVerifiedSecondPage(tx, {
      ideaId, actorUserId: idea.actorUserId, keys,
      firstSourcePlanRevisionId: firstChunk.sourcePlanRevisionId,
      ideaCompletedAt: idea.analysisCompletedAt, partial,
      chunk,
    });
    const firstPage: AmuxIdeaAnalysisResultPage = {
      chunkIndex: 0, previewId: first.previewId,
      completedAt: first.completedAt, outcome: "propose",
      coveredScope: first.coveredScope, remainingScope: first.remainingScope,
      units: first.units,
    };
    return { state: partial ? "continued_partial" : "continued_ready", ideaId,
      pages: [firstPage, page] };
}

async function readVerifiedSecondPage(tx: Prisma.TransactionClient, input: {
  ideaId: string; actorUserId: string; keys: AmuxContentKeys;
  firstSourcePlanRevisionId: string | null;
  ideaCompletedAt: Date | null; partial: boolean;
  chunk: AmuxIdeaAnalysisChunk;
}): Promise<AmuxIdeaAnalysisResultPage> {
  const { ideaId, actorUserId, chunk, keys, partial } = input;
  const clock = await tx.$queryRaw<Array<{ now: Date }>>`
    SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
  `;
  const now = clock[0]?.now;
  const units = await tx.amuxIdeaDraftUnit.findMany({
    where: { ideaId, actorUserId, chunkIndex: 1 }, orderBy: { unitIndex: "asc" },
  });
  const audits = await tx.adminAuditLog.findMany({
    where: { action: AMUX_V4_SECOND_DRAFT_SAVED_ACTION,
      targetType: AMUX_V4_SECOND_DRAFT_SAVED_TARGET,
      targetId: `${ideaId}:1` }, take: 2,
  });
  const firstAudits = await tx.adminAuditLog.findMany({
    where: { action: AMUX_V4_FIRST_DRAFT_SAVED_ACTION,
      targetType: AMUX_V4_FIRST_DRAFT_SAVED_TARGET,
      targetId: `${ideaId}:0` }, take: 2, select: { entryHash: true },
  });
  const preview = chunk.currentPreviewId
    ? await tx.amuxIdeaTransferPreview.findUnique({
      where: { id: chunk.currentPreviewId },
    }) : null;
  const nextChunk = partial ? await tx.amuxIdeaAnalysisChunk.findUnique({
    where: { ideaId_chunkIndex: { ideaId, chunkIndex: 2 } },
  }) : null;
  const audit = audits[0];
  const metadata = audit?.metadata;
  const meta = metadata as Record<string, unknown> | undefined;
  if (!(now instanceof Date) || !Number.isFinite(now.getTime()) ||
      audits.length !== 1 || firstAudits.length !== 1 ||
      !firstAudits[0]?.entryHash || !audit?.entryHash ||
      auditRowActorKind(audit) !== "system" ||
      !metadata || typeof metadata !== "object" || Array.isArray(metadata) ||
      chunk.actorUserId !== actorUserId || chunk.state !== "draft_ready" ||
      chunk.draftVersion !== 2 || chunk.draftCiphertext !== null ||
      !chunk.currentPreviewId || !chunk.analysisCompletedAt ||
      chunk.revisionChunkIndex !== 1 || chunk.planStartChunkIndex !== 0 ||
      chunk.sourcePlanRevisionId !== input.firstSourcePlanRevisionId ||
      chunk.coveredStartOrdinal !== 0 || chunk.coveredEndOrdinal !== 0 ||
      chunk.outputPartIndex !== 1 ||
      (partial ? chunk.coverageStatus !== "more" ||
        chunk.continuationKind !== "output" || chunk.outputPending !== true ||
        chunk.remainingStartOrdinal !== 0 || chunk.remainingEndOrdinal !== 0 ||
        meta?.nextChunkIndex !== 2 || !nextChunk ||
        nextChunk.actorUserId !== actorUserId ||
        nextChunk.sourcePlanRevisionId !== chunk.sourcePlanRevisionId ||
        nextChunk.planStartChunkIndex !== 0 || nextChunk.revisionChunkIndex !== 2 :
        chunk.coverageStatus !== "complete" || chunk.continuationKind !== null ||
        chunk.outputPending !== false || chunk.remainingStartOrdinal !== null ||
        chunk.remainingEndOrdinal !== null ||
        chunk.analysisCompletedAt.getTime() !== input.ideaCompletedAt?.getTime() ||
        meta?.nextChunkIndex !== null) ||
      !preview || preview.ideaId !== ideaId || preview.chunkIndex !== 1 ||
      preview.state !== "completed" ||
      preview.sourcePlanRevisionId !== chunk.sourcePlanRevisionId ||
      meta?.ideaId !== ideaId || meta.previewId !== chunk.currentPreviewId ||
      meta.previousChunkAuditHash !== firstAudits[0].entryHash ||
      meta.unitCount !== units.length ||
      !matchesAmuxIdeaAnalysisCursorAudit(metadata, chunk, partial) ||
      !matchesAmuxIdeaAnalysisUnitCommitments(meta.unitCommitments, units) ||
      meta.cardRegistrationStarted !== false ||
      (partial ? meta.outcome !== "propose" :
        !["propose", "reject"].includes(String(meta.outcome))) ||
      units.length > 40 ||
      !chunk.freeformPurgeAfter ||
      (!chunk.freeformCiphertext && chunk.freeformPurgedAt === null &&
        now < chunk.freeformPurgeAfter)) {
    throw new AmuxIdeaAnalysisResultReadError("integrity_unavailable");
  }
  let freeform: Buffer | undefined;
  const plaintextUnits: Buffer[] = [];
  try {
    let coveredScope: string | null = null;
    let remainingScope: string | null = null;
    if (chunk.freeformPurgedAt === null && now < chunk.freeformPurgeAfter) {
      if (!chunk.freeformCiphertext || !chunk.freeformKeyId ||
          !chunk.freeformKeyVersion) throw new Error("freeform body missing");
      const subject = amuxAnalysisFreeformSubjectId(ideaId, chunk.currentPreviewId);
      freeform = openAmuxContent({ ciphertext: Buffer.from(chunk.freeformCiphertext),
        keyId: chunk.freeformKeyId, keyVersion: chunk.freeformKeyVersion },
      "analysis_freeform", subject, keys);
      if (!verifyAmuxContentDigest(freeform, "analysis_freeform", subject,
        meta.freeformDigest as string, meta.freeformDigestKeyId as string, keys)) {
        throw new Error("freeform digest mismatch");
      }
      const value: unknown = JSON.parse(freeform.toString("utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("freeform structure mismatch");
      }
      const record = value as Record<string, unknown>;
      if (record.previewId !== chunk.currentPreviewId || record.chunkIndex !== 1 ||
          record.outcome !== meta.outcome ||
          record.coverageStatus !== chunk.coverageStatus ||
          record.continuationKind !== chunk.continuationKind ||
          typeof record.coveredScope !== "string" ||
          !amuxAnalysisTextSafe(record.coveredScope) ||
          (partial && (typeof record.remainingScope !== "string" ||
            !amuxAnalysisTextSafe(record.remainingScope))) ||
          (!partial && record.remainingScope !== null)) {
        throw new Error("freeform identity mismatch");
      }
      coveredScope = record.coveredScope;
      remainingScope = partial ? record.remainingScope as string : null;
    }
    const visibleUnits: AmuxVisibleAnalysisUnit[] = [];
    for (const [index, unit] of units.entries()) {
      if (unit.unitIndex !== index || unit.ideaId !== ideaId ||
          unit.actorUserId !== actorUserId || !unit.localRef ||
          !["proposed", "approved", "rejected", "expired"].includes(unit.state)) {
        throw new Error("proposal unit mismatch");
      }
      const bodyUnavailable = unit.state === "expired" || now >= unit.expiresAt ||
        unit.bodyPurgedAt !== null ||
        (unit.bodyPurgeAfter !== null && now >= unit.bodyPurgeAfter);
      if (bodyUnavailable) {
        visibleUnits.push({ id: unit.id, localRef: unit.localRef,
          bodyDigest: unit.bodyDigest, bodyDigestKeyId: unit.bodyDigestKeyId,
          decisionState: unit.state as AmuxVisibleAnalysisUnit["decisionState"],
          proposal: null });
        continue;
      }
      if (!unit.bodyCiphertext || !unit.bodyKeyId || !unit.bodyKeyVersion) {
        throw new Error("proposal body missing");
      }
      const plain = openAmuxContent({ ciphertext: Buffer.from(unit.bodyCiphertext),
        keyId: unit.bodyKeyId, keyVersion: unit.bodyKeyVersion },
      "analysis_draft", unit.id, keys);
      plaintextUnits.push(plain);
      if (!verifyAmuxContentDigest(plain, "analysis_draft", unit.id,
        unit.bodyDigest, unit.bodyDigestKeyId, keys)) {
        throw new Error("proposal digest mismatch");
      }
      const inspected = inspectAmuxStoredAnalysisUnit({
        raw: plain.toString("utf8"), chunkIndex: 1,
        permittedSourceRefIds: ["operator_idea"],
      });
      if (!inspected.ok || inspected.unit.localId !== unit.localRef ||
          inspected.unit.kind !== unit.unitKind) {
        throw new Error("proposal structure mismatch");
      }
      visibleUnits.push({ id: unit.id, localRef: unit.localRef,
        bodyDigest: unit.bodyDigest, bodyDigestKeyId: unit.bodyDigestKeyId,
        decisionState: unit.state as AmuxVisibleAnalysisUnit["decisionState"],
        proposal: inspected.unit });
    }
    return { chunkIndex: 1, previewId: chunk.currentPreviewId,
      completedAt: chunk.analysisCompletedAt.toISOString(),
      outcome: meta.outcome as "propose" | "reject",
      coveredScope, remainingScope, units: visibleUnits };
  } catch {
    throw new AmuxIdeaAnalysisResultReadError("integrity_unavailable");
  } finally {
    freeform?.fill(0);
    for (const plain of plaintextUnits) plain.fill(0);
  }
}
