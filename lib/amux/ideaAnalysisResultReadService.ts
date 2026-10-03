import "server-only";

import { Prisma } from "@prisma/client";
import type { Session } from "next-auth";

import { auditRowActorKind, AMUX_V4_FIRST_DRAFT_SAVED_ACTION,
  AMUX_V4_FIRST_DRAFT_SAVED_TARGET } from "@/lib/adminAuditSystemActors";
import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { prisma } from "@/lib/prisma";
import { amuxAnalysisTextSafe, inspectAmuxAnalysisChunk,
  inspectAmuxStoredAnalysisUnit } from "./ideaAnalysisChunkCore.ts";
import { amuxAnalysisFreeformSubjectId } from "./ideaAnalysisDraftSealCore.ts";
import { matchesAmuxIdeaAnalysisCursorAudit,
  matchesAmuxIdeaAnalysisUnitCommitments } from
  "./ideaAnalysisResultReadCore.ts";
import type { AmuxIdeaAnalysisResultView, AmuxVisibleAnalysisUnit } from
  "./ideaAnalysisResultReadCore.ts";
import { openAmuxContent, verifyAmuxContentDigest,
  type AmuxContentKeys } from "./ideaCrypto.ts";

export class AmuxIdeaAnalysisResultReadError extends Error {
  constructor(readonly code: "not_found" | "integrity_unavailable") {
    super(code);
    this.name = "AmuxIdeaAnalysisResultReadError";
  }
}

/** Owner-only, exact-idea read. No writes, external calls or card admission.
 * Expired unit bodies are explicit metadata-only rows, never silently omitted;
 * freeform expiry does not hide 30-day unit proposals. */
export async function readAmuxFirstIdeaAnalysisResultInTransaction(
  tx: Prisma.TransactionClient, session: Session, ideaId: string,
  keys: AmuxContentKeys,
): Promise<AmuxIdeaAnalysisResultView> {
  const actorUserId = session.user?.id;
  if (!actorUserId || !isAdminSession(session) || getAdminRole(session) !== "owner" ||
      !/^[A-Za-z0-9:_-]{1,128}$/.test(ideaId)) {
    throw new AmuxIdeaAnalysisResultReadError("not_found");
  }
  return readVerifiedAmuxFirstIdeaAnalysisResultInTransaction(
    tx, actorUserId, ideaId, keys);
}

/** Internal only: the caller must already bind actorUserId to a locked idea
 * and independently authenticate its fenced invocation. This helper grants
 * no owner permission and is never exposed by an HTTP route. */
export async function readVerifiedAmuxFirstIdeaAnalysisResultInTransaction(
  tx: Prisma.TransactionClient, actorUserId: string, ideaId: string,
  keys: AmuxContentKeys,
): Promise<AmuxIdeaAnalysisResultView> {
  if (!actorUserId || !/^[A-Za-z0-9:_-]{1,128}$/.test(ideaId)) {
    throw new AmuxIdeaAnalysisResultReadError("not_found");
  }
    const clock = await tx.$queryRaw<Array<{ now: Date }>>`
      SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
    `;
    const now = clock[0]?.now;
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
      throw new AmuxIdeaAnalysisResultReadError("integrity_unavailable");
    }
    const idea = await tx.amuxIdeaSubmission.findFirst({
      where: { id: ideaId, actorUserId },
      select: { state: true, analysisCompletedAt: true },
    });
    if (!idea) throw new AmuxIdeaAnalysisResultReadError("not_found");
    if (idea.state === "cancelled") return { state: "cancelled" };
    if (idea.state === "submitted") return { state: "pending" };
    const partial = idea.state === "analyzing" && idea.analysisCompletedAt === null;
    if (!partial && (idea.state !== "awaiting_owner" || !idea.analysisCompletedAt)) {
      throw new AmuxIdeaAnalysisResultReadError("integrity_unavailable");
    }
    const chunk = await tx.amuxIdeaAnalysisChunk.findUnique({
      where: { ideaId_chunkIndex: { ideaId, chunkIndex: 0 } },
    });
    if (partial && (!chunk || chunk.state !== "draft_ready")) {
      return { state: "pending" };
    }
    const nextChunk = partial ? await tx.amuxIdeaAnalysisChunk.findUnique({
      where: { ideaId_chunkIndex: { ideaId, chunkIndex: 1 } },
    }) : null;
    const units = await tx.amuxIdeaDraftUnit.findMany({
      where: { ideaId, actorUserId, chunkIndex: 0 },
      orderBy: { unitIndex: "asc" },
    });
    const audits = await tx.adminAuditLog.findMany({
      where: { action: AMUX_V4_FIRST_DRAFT_SAVED_ACTION,
        targetType: AMUX_V4_FIRST_DRAFT_SAVED_TARGET, targetId: `${ideaId}:0` },
      take: 2,
    });
    const audit = audits[0];
    const metadata = audit?.metadata;
    const meta = metadata as Record<string, unknown> | undefined;
    if (!chunk || audits.length !== 1 || chunk.actorUserId !== actorUserId ||
        chunk.state !== "draft_ready" || chunk.draftVersion !== 2 ||
        chunk.draftCiphertext !== null || !chunk.currentPreviewId ||
        !chunk.analysisCompletedAt ||
        (partial ? chunk.coverageStatus !== "more" ||
          chunk.continuationKind !== "output" || chunk.outputPending !== true ||
          chunk.outputPartIndex !== 0 || chunk.revisionChunkIndex !== 0 ||
          chunk.coveredStartOrdinal !== 0 || chunk.coveredEndOrdinal !== 0 ||
          chunk.remainingStartOrdinal !== 0 || chunk.remainingEndOrdinal !== 0 :
          chunk.analysisCompletedAt.getTime() !== idea.analysisCompletedAt!.getTime() ||
          chunk.coverageStatus !== "complete" ||
          chunk.continuationKind !== null || chunk.outputPending !== false ||
          chunk.remainingStartOrdinal !== null || chunk.remainingEndOrdinal !== null) ||
        !audit?.entryHash || auditRowActorKind(audit) !== "system" ||
        !metadata || typeof metadata !== "object" || Array.isArray(metadata) ||
        meta?.ideaId !== ideaId || meta.previewId !== chunk.currentPreviewId ||
        meta.unitCount !== units.length ||
        !matchesAmuxIdeaAnalysisCursorAudit(metadata, chunk, partial) ||
        (partial ? meta.nextChunkIndex !== 1 || !nextChunk ||
          nextChunk.actorUserId !== actorUserId ||
          nextChunk.sourcePlanRevisionId !== chunk.sourcePlanRevisionId ||
          nextChunk.planStartChunkIndex !== 0 || nextChunk.revisionChunkIndex !== 1 :
          Object.hasOwn(meta, "nextChunkIndex") && meta.nextChunkIndex !== null) ||
        !matchesAmuxIdeaAnalysisUnitCommitments(meta.unitCommitments, units) ||
        meta.cardRegistrationStarted !== false ||
        !["propose", "reject"].includes(String(meta.outcome)) ||
        (partial && meta.outcome !== "propose") ||
        units.length > 40) {
      throw new AmuxIdeaAnalysisResultReadError("integrity_unavailable");
    }
    if (!chunk.freeformPurgeAfter ||
        (!chunk.freeformCiphertext && chunk.freeformPurgedAt === null &&
          now < chunk.freeformPurgeAfter)) {
      throw new AmuxIdeaAnalysisResultReadError("integrity_unavailable");
    }
    let freeform: Buffer | undefined;
    const plaintextUnits: Buffer[] = [];
    try {
      const previewId = chunk.currentPreviewId;
      let freeformValue: Record<string, unknown> | null = null;
      if (chunk.freeformPurgedAt === null && now < chunk.freeformPurgeAfter) {
        if (!chunk.freeformCiphertext || !chunk.freeformKeyId || !chunk.freeformKeyVersion) {
          throw new Error("freeform body missing");
        }
        const subject = amuxAnalysisFreeformSubjectId(ideaId, previewId);
        freeform = openAmuxContent({ ciphertext: Buffer.from(chunk.freeformCiphertext),
          keyId: chunk.freeformKeyId, keyVersion: chunk.freeformKeyVersion },
        "analysis_freeform", subject, keys);
        if (!verifyAmuxContentDigest(freeform, "analysis_freeform", subject,
          meta!.freeformDigest as string, meta!.freeformDigestKeyId as string, keys)) {
          throw new Error("freeform digest mismatch");
        }
        const parsed: unknown = JSON.parse(freeform.toString("utf8"));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("freeform structure mismatch");
        }
        freeformValue = parsed as Record<string, unknown>;
        if (freeformValue.previewId !== previewId || freeformValue.chunkIndex !== 0 ||
            freeformValue.outcome !== meta!.outcome ||
            freeformValue.coverageStatus !== chunk.coverageStatus ||
            freeformValue.continuationKind !== chunk.continuationKind ||
            (partial && (typeof freeformValue.remainingScope !== "string" ||
              !amuxAnalysisTextSafe(freeformValue.remainingScope))) ||
            typeof freeformValue.coveredScope !== "string" ||
            !amuxAnalysisTextSafe(freeformValue.coveredScope)) {
          throw new Error("freeform identity mismatch");
        }
      }
      const proposalUnits: unknown[] = [];
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
        const inspectedUnit = inspectAmuxStoredAnalysisUnit({
          raw: plain.toString("utf8"), chunkIndex: 0,
          permittedSourceRefIds: ["operator_idea"],
        });
        if (!inspectedUnit.ok || inspectedUnit.unit.localId !== unit.localRef ||
            inspectedUnit.unit.kind !== unit.unitKind) {
          throw new Error("proposal structure mismatch");
        }
        proposalUnits.push(inspectedUnit.unit);
        visibleUnits.push({ id: unit.id, localRef: unit.localRef,
          bodyDigest: unit.bodyDigest, bodyDigestKeyId: unit.bodyDigestKeyId,
          decisionState: unit.state as AmuxVisibleAnalysisUnit["decisionState"],
          proposal: inspectedUnit.unit });
      }
      if (freeformValue && proposalUnits.length === units.length) {
        const inspected = inspectAmuxAnalysisChunk({
          raw: JSON.stringify({ ...freeformValue, units: proposalUnits }),
          expectedPreviewId: previewId, expectedChunkIndex: 0,
          expectedRevisionChunkIndex: 0, previousContinuationKind: null,
          permittedSourceRefIds: ["operator_idea"], permittedTargetRefs: [],
        });
        if (!inspected.ok ||
            inspected.chunk.coverageStatus !== chunk.coverageStatus ||
            inspected.chunk.continuationKind !== chunk.continuationKind ||
            inspected.chunk.outcome !== meta!.outcome) {
          throw new Error("proposal mismatch");
        }
      }
      const shared = { ideaId, previewId,
        completedAt: chunk.analysisCompletedAt.toISOString(),
        coveredScope: freeformValue?.coveredScope as string | undefined ?? null,
        units: visibleUnits };
      if (partial) return { state: "partial", ...shared, outcome: "propose",
        remainingScope: freeformValue?.remainingScope as string | undefined ?? null };
      return { state: "ready", ...shared,
        outcome: meta!.outcome as "propose" | "reject" };
    } catch {
      throw new AmuxIdeaAnalysisResultReadError("integrity_unavailable");
    } finally {
      freeform?.fill(0);
      for (const plain of plaintextUnits) plain.fill(0);
    }
}

export async function readAmuxFirstIdeaAnalysisResult(
  session: Session, ideaId: string, keys: AmuxContentKeys,
): Promise<AmuxIdeaAnalysisResultView> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT set_config('statement_timeout', '2000', true) AS statement_limit,
             set_config('idle_in_transaction_session_timeout', '5000', true) AS idle_limit
    `;
    return readAmuxFirstIdeaAnalysisResultInTransaction(tx, session, ideaId, keys);
  },
  { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    maxWait: 2_000, timeout: 8_000 });
}
