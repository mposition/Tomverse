import "server-only";

import { Prisma, type AmuxIdeaAnalysisChunk } from "@prisma/client";
import type { Session } from "next-auth";

import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { auditRowActorKind, AMUX_V4_FIRST_DRAFT_SAVED_ACTION,
  AMUX_V4_FIRST_DRAFT_SAVED_TARGET, AMUX_V4_SECOND_DRAFT_SAVED_ACTION,
  AMUX_V4_SECOND_DRAFT_SAVED_TARGET } from "@/lib/adminAuditSystemActors";
import { prisma } from "@/lib/prisma";
import { amuxAnalysisTextSafe, amuxPermittedTargetRefSafe,
  inspectAmuxStoredAnalysisUnit, snapshotAmuxPermittedTarget } from
  "./ideaAnalysisChunkCore.ts";
import type { AmuxPermittedTargetRef } from "./ideaAnalysisChunkCore.ts";
import { amuxAnalysisFreeformSubjectId } from "./ideaAnalysisDraftSealCore.ts";
import { amuxCanonicalJson } from "./boardImportCore.ts";
import { readVerifiedAmuxOwnerInputHold } from "./ideaAnalysisOwnerInputReadService.ts";
import { readVerifiedAmuxFirstIdeaAnalysisResultInTransaction,
  AmuxIdeaAnalysisResultReadError } from "./ideaAnalysisResultReadService.ts";
import { matchesAmuxIdeaAnalysisCursorAudit,
  matchesAmuxIdeaAnalysisUnitCommitments } from "./ideaAnalysisResultReadCore.ts";
import type { AmuxIdeaAnalysisResultPage, AmuxIdeaAnalysisResultView,
  AmuxVisibleAnalysisUnit } from "./ideaAnalysisResultReadCore.ts";
import { openAmuxContent, verifyAmuxContentDigest,
  type AmuxContentKeys } from "./ideaCrypto.ts";

/** Owner-only consistent read of bounded pages. A completed
 * continuation is not represented as a completed first page: each stored page
 * keeps its own audit, digest, expiry and independently purgeable unit bodies. */
export async function readAmuxIdeaAnalysisResult(
  session: Session, ideaId: string, keys: AmuxContentKeys,
  startChunkIndex = 0,
): Promise<AmuxIdeaAnalysisResultView> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT set_config('statement_timeout', '3000', true) AS statement_limit,
             set_config('idle_in_transaction_session_timeout', '6000', true) AS idle_limit
    `;
    return readAmuxIdeaAnalysisResultInTransaction(tx, session, ideaId, keys,
      startChunkIndex);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    maxWait: 2_000, timeout: 10_000 });
}

/** Shared transaction body for owner read-back and atomic writer tests. */
export async function readAmuxIdeaAnalysisResultInTransaction(
  tx: Prisma.TransactionClient, session: Session, ideaId: string,
  keys: AmuxContentKeys, startChunkIndex = 0,
): Promise<AmuxIdeaAnalysisResultView> {
    const actorUserId = session.user?.id;
    if (!actorUserId || !isAdminSession(session) ||
        getAdminRole(session) !== "owner") {
      throw new AmuxIdeaAnalysisResultReadError("not_found");
    }
    if (!Number.isSafeInteger(startChunkIndex) || startChunkIndex < 0 ||
        startChunkIndex >= 2_147_483_647) {
      throw new AmuxIdeaAnalysisResultReadError("not_found");
    }
    return startChunkIndex === 0
      ? readVerifiedAmuxIdeaAnalysisResultInTransaction(tx, actorUserId, ideaId, keys)
      : readVerifiedAmuxIdeaAnalysisResultWindowInTransaction(
        tx, actorUserId, ideaId, keys, startChunkIndex);
}

export async function readVerifiedAmuxIdeaAnalysisResultWindowInTransaction(
  tx: Prisma.TransactionClient, actorUserId: string, ideaId: string,
  keys: AmuxContentKeys, startChunkIndex: number,
): Promise<AmuxIdeaAnalysisResultView> {
  if (!Number.isSafeInteger(startChunkIndex) || startChunkIndex < 1 ||
      startChunkIndex >= 2_147_483_647) {
    throw new AmuxIdeaAnalysisResultReadError("not_found");
  }
  const pages: AmuxIdeaAnalysisResultPage[] = [];
  const scan = await scanVerifiedAmuxIdeaAnalysisPagesInTransaction(
    tx, actorUserId, ideaId, keys, (page) => {
      if (page.chunkIndex >= startChunkIndex && pages.length < 16) pages.push(page);
    });
  if (pages.length === 0 || scan.pageCount < startChunkIndex + pages.length) {
    throw new AmuxIdeaAnalysisResultReadError("not_found");
  }
  if (!scan.complete) {
    const next = await tx.amuxIdeaAnalysisChunk.findUnique({
      where: { ideaId_chunkIndex: { ideaId, chunkIndex: scan.pageCount } },
      select: { state: true },
    });
    if (next?.state === "owner_input") {
      return readVerifiedAmuxOwnerInputHold(tx, actorUserId, ideaId,
        scan.pageCount, keys);
    }
  }
  return { state: "continued_window", ideaId, startChunkIndex,
    nextChunkIndex: scan.pageCount > startChunkIndex + pages.length
      ? startChunkIndex + pages.length : null,
    complete: scan.complete, pages };
}

/** Internal read after a caller has already bound the locked idea to an
 * authenticated actor. It never grants owner access on its own. */
export async function readVerifiedAmuxIdeaAnalysisResultInTransaction(
  tx: Prisma.TransactionClient, actorUserId: string, ideaId: string,
  keys: AmuxContentKeys,
): Promise<AmuxIdeaAnalysisResultView> {
    const pages: AmuxIdeaAnalysisResultPage[] = [];
    const scan = await scanVerifiedAmuxIdeaAnalysisPagesInTransaction(
      tx, actorUserId, ideaId, keys, (page) => {
        if (pages.length < 16) pages.push(page);
      });
    if (scan.first.state !== "partial") return scan.first;
    if (!scan.complete) {
      const next = await tx.amuxIdeaAnalysisChunk.findUnique({
        where: { ideaId_chunkIndex: { ideaId, chunkIndex: scan.pageCount } },
        select: { state: true },
      });
      if (next?.state === "owner_input") {
        return readVerifiedAmuxOwnerInputHold(tx, actorUserId, ideaId,
          scan.pageCount, keys);
      }
    }
    if (scan.pageCount === 1) return scan.first;
    if (scan.pageCount > 16) {
      return { state: "continued_window", ideaId, startChunkIndex: 0,
        nextChunkIndex: 16, complete: scan.complete,
        pages: pages as [AmuxIdeaAnalysisResultPage,
          AmuxIdeaAnalysisResultPage, ...AmuxIdeaAnalysisResultPage[]] };
    }
    return { state: scan.complete ? "continued_ready" : "continued_partial",
      ideaId, pages: pages as [AmuxIdeaAnalysisResultPage,
        AmuxIdeaAnalysisResultPage, ...AmuxIdeaAnalysisResultPage[]] };
}

/** Verify every predecessor in cursor order while retaining only a bounded
 * caller-selected projection. No proposal page history is assembled in RAM. */
export async function scanVerifiedAmuxIdeaAnalysisPagesInTransaction(
  tx: Prisma.TransactionClient, actorUserId: string, ideaId: string,
  keys: AmuxContentKeys, onPage: (page: AmuxIdeaAnalysisResultPage) => void,
): Promise<{ first: AmuxIdeaAnalysisResultView; pageCount: number;
  lastPage: AmuxIdeaAnalysisResultPage | null; complete: boolean }> {
    const first = await readVerifiedAmuxFirstIdeaAnalysisResultInTransaction(
      tx, actorUserId, ideaId, keys);
    if (first.state !== "partial") {
      return { first, pageCount: 0, lastPage: null, complete: first.state === "ready" };
    }
    const idea = await tx.amuxIdeaSubmission.findUnique({ where: { id: ideaId } });
    const firstChunk = await tx.amuxIdeaAnalysisChunk.findUnique({
      where: { ideaId_chunkIndex: { ideaId, chunkIndex: 0 } },
    });
    if (!idea || idea.actorUserId !== actorUserId || !firstChunk ||
        firstChunk.currentPreviewId !== first.previewId) {
      throw new AmuxIdeaAnalysisResultReadError("integrity_unavailable");
    }
    const firstPage: AmuxIdeaAnalysisResultPage = {
      chunkIndex: 0, previewId: first.previewId,
      completedAt: first.completedAt, outcome: "propose",
      coveredScope: first.coveredScope, remainingScope: first.remainingScope,
      units: first.units,
    };
    onPage(firstPage);
    let pageCount = 1;
    let lastPage = firstPage;
    while (pageCount < 2_147_483_647) {
      const batch = await tx.amuxIdeaAnalysisChunk.findMany({
        where: { ideaId, chunkIndex: { gte: pageCount } },
        orderBy: { chunkIndex: "asc" }, take: 16,
      });
      if (batch.length === 0) throw new AmuxIdeaAnalysisResultReadError("integrity_unavailable");
      for (const chunk of batch) {
        const chunkIndex = pageCount;
        if (chunk.chunkIndex !== chunkIndex) {
          throw new AmuxIdeaAnalysisResultReadError("integrity_unavailable");
        }
        if (chunk.state !== "draft_ready") {
          if (idea.state !== "analyzing" || idea.analysisCompletedAt !== null) {
            throw new AmuxIdeaAnalysisResultReadError("integrity_unavailable");
          }
          return { first, pageCount, lastPage, complete: false };
        }
        const partial = chunk.outputPending === true;
        if (!partial && (idea.state !== "awaiting_owner" || !idea.analysisCompletedAt)) {
          throw new AmuxIdeaAnalysisResultReadError("integrity_unavailable");
        }
        const page = await readVerifiedContinuedPage(tx, {
          ideaId, actorUserId: idea.actorUserId, keys, chunkIndex,
          firstSourcePlanRevisionId: firstChunk.sourcePlanRevisionId,
          ideaCompletedAt: idea.analysisCompletedAt, partial, chunk,
        });
        onPage(page);
        pageCount += 1;
        lastPage = page;
        if (!partial) return { first, pageCount, lastPage, complete: true };
      }
    }
    throw new AmuxIdeaAnalysisResultReadError("integrity_unavailable");
}

/** Continuation writers retain only the last page and a bounded reference
 * projection, never the entire sequence of decrypted proposal pages. */
export async function readVerifiedAmuxIdeaAnalysisContinuationContext(
  tx: Prisma.TransactionClient, actorUserId: string, ideaId: string,
  keys: AmuxContentKeys,
  pinnedRefs: readonly string[] = [],
): Promise<{ pageCount: number; previous: AmuxIdeaAnalysisResultPage;
  priorTargets: AmuxPermittedTargetRef[];
  validationTargets: AmuxPermittedTargetRef[];
  targets: AmuxPermittedTargetRef[]; complete: boolean;
  omittedTargetSummary: { count: number; firstChunkIndex: number;
    lastChunkIndex: number } | null }> {
  const targets: AmuxPermittedTargetRef[] = [];
  let priorTargets: AmuxPermittedTargetRef[] = [];
  let previous: AmuxIdeaAnalysisResultPage | null = null;
  let pinnedCount = 0;
  let omittedCount = 0;
  let firstOmittedChunk = Number.MAX_SAFE_INTEGER;
  let lastOmittedChunk = -1;
  const wanted = new Set(pinnedRefs);
  if (wanted.size !== pinnedRefs.length || wanted.size > 6) {
    throw new AmuxIdeaAnalysisResultReadError("integrity_unavailable");
  }
  // The preceding page was admitted under the final target selection in its
  // owner-confirmed, sealed transfer preview. A later default 96-ref window
  // may omit a pinned old Task; it cannot be used to revalidate that page.
  const latest = await tx.amuxIdeaAnalysisChunk.findFirst({
    where: { ideaId, actorUserId, state: "draft_ready" },
    orderBy: { chunkIndex: "desc" },
    select: { chunkIndex: true, currentPreviewId: true },
  });
  const priorPreview = latest?.currentPreviewId
    ? await tx.amuxIdeaTransferPreview.findUnique({
      where: { id: latest.currentPreviewId },
      select: { ideaId: true, chunkIndex: true, state: true,
        payloadDigest: true, payloadDigestKeyId: true },
    }) : null;
  const preparedAudits = latest?.currentPreviewId
    ? await tx.adminAuditLog.findMany({ where: {
      action: "amux.v4.transfer_preview.prepared",
      targetType: "AmuxIdeaTransferPreview",
      targetId: latest.currentPreviewId, actorUserId,
    }, take: 2 }) : [];
  const preparedAudit = preparedAudits[0];
  const metadata = preparedAudit?.metadata;
  const meta = metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? metadata as Record<string, unknown> : null;
  if (!latest?.currentPreviewId || !priorPreview ||
      priorPreview.ideaId !== ideaId ||
      priorPreview.chunkIndex !== latest.chunkIndex ||
      priorPreview.state !== "completed" ||
      preparedAudits.length !== 1 || !preparedAudit?.entryHash ||
      auditRowActorKind(preparedAudit) !== "human" || !meta ||
      meta.ideaId !== ideaId || meta.chunkIndex !== latest.chunkIndex ||
      meta.payloadDigest !== priorPreview.payloadDigest ||
      meta.payloadDigestKeyId !== priorPreview.payloadDigestKeyId ||
      !Array.isArray(meta.finalPermittedTargetRefs) ||
      meta.finalPermittedTargetRefs.length > 96 ||
      typeof meta.finalPermittedTargetRefsDigest !== "string" ||
      typeof meta.finalPermittedTargetRefsDigestKeyId !== "string") {
    throw new AmuxIdeaAnalysisResultReadError("integrity_unavailable");
  }
  const targetBytes = Buffer.from(amuxCanonicalJson(meta.finalPermittedTargetRefs), "utf8");
  if (targetBytes.length > 16 * 1024 || !verifyAmuxContentDigest(targetBytes,
    "transfer_payload", latest.currentPreviewId,
    meta.finalPermittedTargetRefsDigest,
    meta.finalPermittedTargetRefsDigestKeyId, keys)) {
    throw new AmuxIdeaAnalysisResultReadError("integrity_unavailable");
  }
  const validationTargets = meta.finalPermittedTargetRefs.map((value: unknown) =>
    snapshotAmuxPermittedTarget(value));
  if (validationTargets.some((value) => !value ||
      !amuxPermittedTargetRefSafe(value, latest.chunkIndex)) ||
      new Set(validationTargets.map((value) => value?.ref)).size !==
        validationTargets.length) {
    throw new AmuxIdeaAnalysisResultReadError("integrity_unavailable");
  }
  const expected = new Map(validationTargets.map((value) =>
    [value!.ref, amuxCanonicalJson(value)]));
  const observed = new Set<string>();
  const verifiedPins = new Map<string, AmuxPermittedTargetRef>();
  const scan = await scanVerifiedAmuxIdeaAnalysisPagesInTransaction(
    tx, actorUserId, ideaId, keys, (page) => {
      if (!page.coveredScope ||
          page.units.some((unit) => unit.decisionState !== "proposed" ||
            !unit.proposal)) {
        throw new AmuxIdeaAnalysisResultReadError("integrity_unavailable");
      }
      const currentRefs = new Set<string>();
      for (const entry of page.units) {
        const unit = entry.proposal!;
        let target: AmuxPermittedTargetRef | null = null;
        if (unit.kind === "node") target = { ref: unit.localId,
          kind: "node", level: unit.level };
        if (unit.kind === "card") target = { ref: unit.localId,
          kind: "card", cardType: unit.cardType,
          storyKind: unit.storyKind, featureRef: unit.featureRef };
        if (target) {
          const expectedIdentity = expected.get(target.ref);
          if (expectedIdentity !== undefined) {
            if (page.chunkIndex >= latest.chunkIndex ||
                expectedIdentity !== amuxCanonicalJson(target)) {
              throw new AmuxIdeaAnalysisResultReadError("integrity_unavailable");
            }
            observed.add(target.ref);
          }
          if (wanted.has(target.ref)) verifiedPins.set(target.ref, target);
          currentRefs.add(target.ref);
          if (targets.length === 96) {
            const displacedPinned = pinnedCount === targets.length;
            const displaced = targets.splice(displacedPinned ? 0 : pinnedCount, 1)[0];
            if (!displaced) {
              throw new AmuxIdeaAnalysisResultReadError("integrity_unavailable");
            }
            if (displacedPinned) pinnedCount -= 1;
            const sourceChunk = Number(/^c([0-9]+):/.exec(displaced.ref)?.[1]);
            if (!Number.isSafeInteger(sourceChunk)) {
              throw new AmuxIdeaAnalysisResultReadError("integrity_unavailable");
            }
            omittedCount += 1;
            firstOmittedChunk = Math.min(firstOmittedChunk, sourceChunk);
            lastOmittedChunk = Math.max(lastOmittedChunk, sourceChunk);
          }
          if (target.kind === "node" ||
              (target.kind === "card" && target.cardType === "story")) {
            targets.splice(pinnedCount, 0, target);
            pinnedCount += 1;
          } else {
            targets.push(target);
          }
        }
      }
      priorTargets = targets.filter((target) => !currentRefs.has(target.ref));
      previous = page;
    });
  if (scan.first.state !== "partial" || !previous) {
    throw new AmuxIdeaAnalysisResultReadError("integrity_unavailable");
  }
  const finalPrevious = previous as AmuxIdeaAnalysisResultPage;
  if (latest.chunkIndex !== scan.pageCount - 1 ||
      latest.currentPreviewId !== finalPrevious.previewId ||
      observed.size !== expected.size) {
    throw new AmuxIdeaAnalysisResultReadError("integrity_unavailable");
  }
  if (verifiedPins.size !== wanted.size) {
    throw new AmuxIdeaAnalysisResultReadError("not_found");
  }
  const currentRefs = new Set(finalPrevious.units.map((unit) => unit.localRef));
  for (const ref of pinnedRefs) {
    if (targets.some((target) => target.ref === ref)) continue;
    const pin = verifiedPins.get(ref)!;
    const victim = targets.findIndex((target) =>
      !wanted.has(target.ref) && !currentRefs.has(target.ref) &&
      target.kind === "card" && target.cardType === "task");
    if (victim < 0) {
      throw new AmuxIdeaAnalysisResultReadError("reference_selection_required");
    }
    const displaced = targets.splice(victim, 1, pin)[0]!;
    const sourceChunk = Number(/^c([0-9]+):/.exec(displaced.ref)?.[1]);
    if (!Number.isSafeInteger(sourceChunk)) {
      throw new AmuxIdeaAnalysisResultReadError("integrity_unavailable");
    }
    firstOmittedChunk = Math.min(firstOmittedChunk, sourceChunk);
    lastOmittedChunk = Math.max(lastOmittedChunk, sourceChunk);
  }
  return { pageCount: scan.pageCount, previous,
    priorTargets, validationTargets: validationTargets as AmuxPermittedTargetRef[],
    targets, complete: scan.complete,
    omittedTargetSummary: omittedCount > 0 ? {
      count: omittedCount, firstChunkIndex: firstOmittedChunk,
      lastChunkIndex: lastOmittedChunk,
    } : null };
}

async function readVerifiedContinuedPage(tx: Prisma.TransactionClient, input: {
  ideaId: string; actorUserId: string; keys: AmuxContentKeys;
  chunkIndex: number;
  firstSourcePlanRevisionId: string | null;
  ideaCompletedAt: Date | null; partial: boolean;
  chunk: AmuxIdeaAnalysisChunk;
}): Promise<AmuxIdeaAnalysisResultPage> {
  const { ideaId, actorUserId, chunk, keys, partial, chunkIndex } = input;
  const clock = await tx.$queryRaw<Array<{ now: Date }>>`
    SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
  `;
  const now = clock[0]?.now;
  const units = await tx.amuxIdeaDraftUnit.findMany({
    where: { ideaId, actorUserId, chunkIndex }, orderBy: { unitIndex: "asc" },
  });
  const audits = await tx.adminAuditLog.findMany({
    where: { action: AMUX_V4_SECOND_DRAFT_SAVED_ACTION,
      targetType: AMUX_V4_SECOND_DRAFT_SAVED_TARGET,
      targetId: `${ideaId}:${chunkIndex}` }, take: 2,
  });
  const firstAudits = await tx.adminAuditLog.findMany({
    where: { action: chunkIndex === 1 ? AMUX_V4_FIRST_DRAFT_SAVED_ACTION :
        AMUX_V4_SECOND_DRAFT_SAVED_ACTION,
      targetType: chunkIndex === 1 ? AMUX_V4_FIRST_DRAFT_SAVED_TARGET :
        AMUX_V4_SECOND_DRAFT_SAVED_TARGET,
      targetId: `${ideaId}:${chunkIndex - 1}` }, take: 2,
    select: { entryHash: true },
  });
  const preview = chunk.currentPreviewId
    ? await tx.amuxIdeaTransferPreview.findUnique({
      where: { id: chunk.currentPreviewId },
    }) : null;
  const nextChunk = partial ? await tx.amuxIdeaAnalysisChunk.findUnique({
    where: { ideaId_chunkIndex: { ideaId, chunkIndex: chunkIndex + 1 } },
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
      chunk.chunkIndex !== chunkIndex || chunk.revisionChunkIndex !== chunkIndex ||
      chunk.planStartChunkIndex !== 0 ||
      chunk.sourcePlanRevisionId !== input.firstSourcePlanRevisionId ||
      chunk.coveredStartOrdinal !== 0 || chunk.coveredEndOrdinal !== 0 ||
      chunk.outputPartIndex !== chunkIndex ||
      (partial ? chunk.coverageStatus !== "more" ||
        chunk.continuationKind !== "output" || chunk.outputPending !== true ||
        chunk.remainingStartOrdinal !== 0 || chunk.remainingEndOrdinal !== 0 ||
        meta?.nextChunkIndex !== chunkIndex + 1 || !nextChunk ||
        nextChunk.actorUserId !== actorUserId ||
        nextChunk.sourcePlanRevisionId !== chunk.sourcePlanRevisionId ||
        nextChunk.planStartChunkIndex !== 0 ||
        nextChunk.revisionChunkIndex !== chunkIndex + 1 :
        chunk.coverageStatus !== "complete" || chunk.continuationKind !== null ||
        chunk.outputPending !== false || chunk.remainingStartOrdinal !== null ||
        chunk.remainingEndOrdinal !== null ||
        chunk.analysisCompletedAt.getTime() !== input.ideaCompletedAt?.getTime() ||
        meta?.nextChunkIndex !== null) ||
      !preview || preview.ideaId !== ideaId || preview.chunkIndex !== chunkIndex ||
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
      if (record.previewId !== chunk.currentPreviewId || record.chunkIndex !== chunkIndex ||
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
        raw: plain.toString("utf8"), chunkIndex,
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
    return { chunkIndex, previewId: chunk.currentPreviewId,
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
