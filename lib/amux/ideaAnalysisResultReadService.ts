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
import { matchesAmuxIdeaAnalysisUnitCommitments } from
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
 * the 24-hour freeform expiry does not hide 30-day unit proposals. */
export async function readAmuxFirstIdeaAnalysisResult(
  session: Session, ideaId: string, keys: AmuxContentKeys,
  chunkIndex = 0,
): Promise<AmuxIdeaAnalysisResultView> {
  const actorUserId = session.user?.id;
  if (!actorUserId || !isAdminSession(session) || getAdminRole(session) !== "owner" ||
      !/^[A-Za-z0-9:_-]{1,128}$/.test(ideaId) ||
      !Number.isSafeInteger(chunkIndex) || chunkIndex < 0 ||
      chunkIndex >= 2_147_483_647) {
    throw new AmuxIdeaAnalysisResultReadError("not_found");
  }
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT set_config('statement_timeout', '2000', true) AS statement_limit,
             set_config('idle_in_transaction_session_timeout', '5000', true) AS idle_limit
    `;
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
    if (idea.state === "submitted" && chunkIndex === 0) {
      const chunk = await tx.amuxIdeaAnalysisChunk.findUnique({
        where: { ideaId_chunkIndex: { ideaId, chunkIndex: 0 } },
        select: { state: true, attempt: true, currentPreviewId: true },
      });
      if (chunk?.state === "awaiting_preview" && chunk.currentPreviewId) {
        const preview = await tx.amuxIdeaTransferPreview.findUnique({
          where: { id: chunk.currentPreviewId },
          select: { ideaId: true, attempt: true, state: true },
        });
        if (preview?.ideaId === ideaId && preview.attempt === chunk.attempt &&
            preview.state === "provider_failed") return { state: "provider_failed" };
        if (preview?.ideaId === ideaId && preview.attempt === chunk.attempt &&
            preview.state === "owner_resolved") return { state: "needs_new_preview" };
      }
      return { state: "pending" };
    }
    if (idea.state !== "analyzing" &&
        (idea.state !== "awaiting_owner" || !idea.analysisCompletedAt)) {
      throw new AmuxIdeaAnalysisResultReadError("integrity_unavailable");
    }
    const chunk = await tx.amuxIdeaAnalysisChunk.findUnique({
      where: { ideaId_chunkIndex: { ideaId, chunkIndex } },
    });
    if (!chunk) return { state: "pending" };
    if (chunk.state === "awaiting_preview" && chunk.currentPreviewId) {
      const preview = await tx.amuxIdeaTransferPreview.findUnique({
        where: { id: chunk.currentPreviewId },
        select: { ideaId: true, chunkIndex: true, attempt: true, state: true },
      });
      if (preview?.ideaId === ideaId && preview.chunkIndex === chunkIndex &&
          preview.attempt === chunk.attempt && preview.state === "owner_resolved") {
        return { state: "needs_new_preview" };
      }
    }
    if (chunk.state !== "draft_ready") return { state: "pending" };
    const partial = chunk.coverageStatus === "more" &&
      chunk.continuationKind === "output";
    const needsOwnerInput = chunk.coverageStatus === "needs_owner_input" &&
      chunk.continuationKind === null;
    const units = await tx.amuxIdeaDraftUnit.findMany({
      where: { ideaId, actorUserId, chunkIndex,
        derivationGroupId: null },
      orderBy: { unitIndex: "asc" },
    });
    const audits = await tx.adminAuditLog.findMany({
      where: { action: AMUX_V4_FIRST_DRAFT_SAVED_ACTION,
        targetType: AMUX_V4_FIRST_DRAFT_SAVED_TARGET,
        targetId: `${ideaId}:${chunkIndex}` },
      take: 2,
    });
    const audit = audits[0];
    const metadata = audit?.metadata;
    const meta = metadata as Record<string, unknown> | undefined;
    if (!chunk || audits.length !== 1 || chunk.actorUserId !== actorUserId ||
        chunk.state !== "draft_ready" || chunk.draftVersion !== 2 ||
        chunk.draftCiphertext !== null || !chunk.currentPreviewId ||
        !chunk.analysisCompletedAt ||
        (!partial && !needsOwnerInput &&
          chunk.analysisCompletedAt.getTime() !== idea.analysisCompletedAt?.getTime()) ||
        !audit?.entryHash || auditRowActorKind(audit) !== "system" ||
        !metadata || typeof metadata !== "object" || Array.isArray(metadata) ||
        meta?.ideaId !== ideaId || meta.previewId !== chunk.currentPreviewId ||
        meta.chunkIndex !== chunkIndex ||
        meta.unitCount !== units.length ||
        !matchesAmuxIdeaAnalysisUnitCommitments(meta.unitCommitments, units) ||
        meta.cardRegistrationStarted !== false ||
        !(needsOwnerInput ? meta.outcome === "needs_information" :
          partial ? meta.outcome === "propose" :
          ["propose", "reject"].includes(String(meta.outcome))) ||
        units.length > 40) {
      throw new AmuxIdeaAnalysisResultReadError("integrity_unavailable");
    }
    if (partial) {
      const next = await tx.amuxIdeaAnalysisChunk.findUnique({
        where: { ideaId_chunkIndex: { ideaId, chunkIndex: chunkIndex + 1 } },
        select: { actorUserId: true, sourcePlanRevisionId: true,
          planStartChunkIndex: true, revisionChunkIndex: true, state: true },
      });
      if (!next || next.actorUserId !== actorUserId ||
          next.sourcePlanRevisionId !== chunk.sourcePlanRevisionId ||
          next.planStartChunkIndex !== 0 ||
          next.revisionChunkIndex !== chunkIndex + 1 ||
          chunk.coverageStatus !== "more" || chunk.continuationKind !== "output" ||
          chunk.outputPending !== true || chunk.remainingStartOrdinal !== 0 ||
          chunk.remainingEndOrdinal !== 0) {
        throw new AmuxIdeaAnalysisResultReadError("integrity_unavailable");
      }
    }
    const freeformVisibleUntil = idea.analysisCompletedAt
      ? new Date(idea.analysisCompletedAt.getTime() + 24 * 60 * 60_000)
      : chunk.freeformPurgeAfter;
    if (!chunk.freeformPurgeAfter ||
        !freeformVisibleUntil ||
        (!chunk.freeformCiphertext && chunk.freeformPurgedAt === null &&
          now < freeformVisibleUntil)) {
      throw new AmuxIdeaAnalysisResultReadError("integrity_unavailable");
    }
    let freeform: Buffer | undefined;
    const plaintextUnits: Buffer[] = [];
    try {
      const previewId = chunk.currentPreviewId;
      let freeformValue: Record<string, unknown> | null = null;
      if (chunk.freeformPurgedAt === null && now < freeformVisibleUntil) {
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
        if (freeformValue.previewId !== previewId ||
            freeformValue.chunkIndex !== chunkIndex ||
            freeformValue.outcome !== meta!.outcome ||
            typeof freeformValue.coveredScope !== "string" ||
            !amuxAnalysisTextSafe(freeformValue.coveredScope) ||
            (partial && (freeformValue.coverageStatus !== "more" ||
              freeformValue.continuationKind !== "output" ||
              typeof freeformValue.remainingScope !== "string" ||
              !amuxAnalysisTextSafe(freeformValue.remainingScope))) ||
            (needsOwnerInput && (freeformValue.coverageStatus !== "needs_owner_input" ||
              (freeformValue.continuationKind !== "input" &&
                freeformValue.continuationKind !== null) ||
              typeof freeformValue.ownerQuestion !== "string" ||
              !amuxAnalysisTextSafe(freeformValue.ownerQuestion)))) {
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
          raw: plain.toString("utf8"), chunkIndex,
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
      if (chunkIndex === 0 && freeformValue &&
          proposalUnits.length === units.length) {
        const inspected = inspectAmuxAnalysisChunk({
          raw: JSON.stringify({ ...freeformValue, units: proposalUnits }),
          expectedPreviewId: previewId, expectedChunkIndex: 0,
          expectedRevisionChunkIndex: 0, previousContinuationKind: null,
          permittedSourceRefIds: ["operator_idea"], permittedTargetRefs: [],
        });
        if (!inspected.ok || inspected.chunk.coverageStatus !==
              (needsOwnerInput ? "needs_owner_input" : partial ? "more" : "complete") ||
            (needsOwnerInput ?
              inspected.chunk.continuationKind !== "input" &&
                inspected.chunk.continuationKind !== null :
              inspected.chunk.continuationKind !== (partial ? "output" : null)) ||
            inspected.chunk.outcome !== meta!.outcome) {
          throw new Error("proposal mismatch");
        }
      }
      if (partial) return { state: "partial", ideaId, previewId,
        completedAt: chunk.analysisCompletedAt.toISOString(), outcome: "propose",
        coveredScope: freeformValue?.coveredScope as string | undefined ?? null,
        remainingScope: freeformValue?.remainingScope as string | undefined ?? null,
        nextChunkIndex: chunkIndex + 1, units: visibleUnits };
      if (needsOwnerInput) return { state: "needs_owner_input", ideaId, previewId,
        completedAt: chunk.analysisCompletedAt.toISOString(),
        outcome: "needs_information",
        coveredScope: freeformValue?.coveredScope as string | undefined ?? null,
        remainingScope: freeformValue?.remainingScope as string | undefined ?? null,
        ownerQuestion: freeformValue?.ownerQuestion as string | undefined ?? null,
        units: visibleUnits };
      return { state: "ready", ideaId, previewId,
        completedAt: chunk.analysisCompletedAt.toISOString(),
        outcome: meta!.outcome as "propose" | "reject",
        coveredScope: freeformValue?.coveredScope as string | undefined ?? null,
        units: visibleUnits };
    } catch {
      throw new AmuxIdeaAnalysisResultReadError("integrity_unavailable");
    } finally {
      freeform?.fill(0);
      for (const plain of plaintextUnits) plain.fill(0);
    }
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    maxWait: 2_000, timeout: 8_000 });
}
