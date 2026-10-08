import "server-only";

import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import type { Session } from "next-auth";

import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { assertRecentAdminAuthentication } from "@/lib/adminReauthentication";
import { prisma } from "@/lib/prisma";
import { assembleAmuxV4CardLink } from "./ideaCardLinkSnapshotCore.ts";
import { AmuxCardDuplicateScanError, loadAmuxCardDuplicateScanner } from
  "./ideaCardDuplicateScanService.ts";
import { loadCurrentAmuxContentKeys } from "./ideaKeyConfig.ts";
import { approvedAncestors } from "./ideaNodeRegistrationService.ts";
import { amuxV4UnitBrowserDigest } from "./ideaUnitBrowserCore.ts";
import { sameAmuxIdeaUnitConfirmation,
  type AmuxIdeaUnitConfirmationSnapshot } from
  "./ideaUnitConfirmationCore.ts";
import { readVerifiedAmuxCardProposal } from
  "./ideaUnitProposalReadService.ts";
import { AMUX_V4_UNIT_WRITE_ENV, AmuxV4UnitDecisionError,
  amuxV4UnitWriteEnabled, commitAmuxV4CardLink,
  commitAmuxV4UnitPrepare,
  markAmuxV4UnitConsumeOutcomeUnknown } from "./ideaUnitDecisionStore.ts";

const ID = /^[A-Za-z0-9_-]{8,80}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const DIGEST = /^[a-f0-9]{64}$/;

function owner(session: Session) {
  const id = session.user?.id;
  if (!id || !isAdminSession(session) || getAdminRole(session) !== "owner") {
    throw new AmuxV4UnitDecisionError("forbidden");
  }
  return id;
}

export async function prepareAmuxV4CardLink(input: {
  session: Session; request: Request; browserNonce: string;
  choice: { ideaId: string; draftUnitId: string; featureNodeId: string;
    targetCardId: string; decisionReason: string; prepareRequestId: string };
}) {
  const actorUserId = owner(input.session);
  await assertRecentAdminAuthentication(input.session);
  if (!amuxV4UnitWriteEnabled(process.env[AMUX_V4_UNIT_WRITE_ENV])) {
    throw new AmuxV4UnitDecisionError("write_disabled");
  }
  const choice = input.choice;
  if (!ID.test(choice.ideaId) || !ID.test(choice.draftUnitId) ||
      !ID.test(choice.featureNodeId) || !ID.test(choice.targetCardId) ||
      !UUID.test(choice.prepareRequestId) ||
      choice.decisionReason !== choice.decisionReason.trim() ||
      choice.decisionReason.length < 3 || choice.decisionReason.length > 500) {
    throw new AmuxV4UnitDecisionError("not_ready");
  }
  const verified = await readVerifiedAmuxCardProposal(input.session,
    choice.ideaId, choice.draftUnitId);
  const scanner = await loadAmuxCardDuplicateScanner();
  const keys = loadCurrentAmuxContentKeys(process.env);
  const decisionId = randomUUID();
  const ownerSession = amuxV4UnitBrowserDigest({ decisionId, actorUserId,
    authenticatedAt: input.session.user?.authenticatedAt,
    nonce: input.browserNonce, key: keys });
  let callbackReturned = false;
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('statement_timeout', '5000', true)`;
      const idea = await tx.amuxIdeaSubmission.findFirst({ where: {
        id: choice.ideaId, actorUserId,
      }, select: { state: true } });
      const unit = await tx.amuxIdeaDraftUnit.findFirst({ where: {
        id: choice.draftUnitId, ideaId: choice.ideaId, actorUserId,
      }, select: { id: true, localRef: true, unitKind: true, state: true,
        bodyDigest: true, bodyDigestKeyId: true, chunkIndex: true,
        expiresAt: true } });
      if (!idea || !["analyzing", "awaiting_owner"].includes(idea.state) ||
          !unit || unit.state !== "proposed" || unit.unitKind !== "card" ||
          unit.localRef !== verified.unit.localRef ||
          unit.bodyDigest !== verified.unit.bodyDigest ||
          unit.bodyDigestKeyId !== verified.unit.bodyDigestKeyId ||
          unit.chunkIndex !== verified.unit.chunkIndex ||
          unit.expiresAt.getTime() !== verified.unit.expiresAt.getTime()) {
        throw new AmuxV4UnitDecisionError("reconfirm");
      }
      const hierarchy = await approvedAncestors(tx, choice.featureNodeId);
      if (hierarchy.length !== 3 || hierarchy[2]?.level !== "feature") {
        throw new AmuxV4UnitDecisionError("reconfirm");
      }
      let sourceFeatureRef = choice.featureNodeId;
      if (verified.proposal.featureRef !== choice.featureNodeId) {
        const sourceUnit = await tx.amuxIdeaDraftUnit.findFirst({ where: {
          ideaId: choice.ideaId, actorUserId,
          localRef: verified.proposal.featureRef, unitKind: "node",
          state: "approved",
        }, select: { id: true } });
        const mapping = sourceUnit ? await tx.amuxIdeaUnitDecision.findFirst({
          where: { draftUnitId: sourceUnit.id, state: "consumed",
            OR: [{ resolvedNodeId: choice.featureNodeId },
              { linkedNodeId: choice.featureNodeId }] },
          select: { id: true },
        }) : null;
        if (!mapping) throw new AmuxV4UnitDecisionError("reconfirm");
        sourceFeatureRef = verified.proposal.featureRef;
      }
      const card = await tx.amuxWorkItem.findUnique({
        where: { id: choice.targetCardId },
        select: { id: true, sourceSystem: true, cardType: true,
          storyKind: true, parentFeatureNodeId: true, status: true,
          revision: true, archivedAt: true, v4TitleDigest: true,
          v4TitleDigestKeyId: true, v4SourceApprovalId: true },
      });
      const cardApproval = card?.v4SourceApprovalId ?
        await tx.amuxIdeaUnitDecision.findUnique({
          where: { id: card.v4SourceApprovalId },
          select: { action: true, state: true, registeredWorkItemId: true },
        }) : null;
      if (!card || card.sourceSystem !== "admin-idea-v4" ||
          card.cardType !== verified.proposal.cardType ||
          card.storyKind !== verified.proposal.storyKind ||
          card.parentFeatureNodeId !== choice.featureNodeId ||
          card.status === "cancelled" || card.archivedAt !== null ||
          !card.v4TitleDigest || !card.v4TitleDigestKeyId ||
          cardApproval?.action !== "register_card" ||
          cardApproval.state !== "consumed" ||
          cardApproval.registeredWorkItemId !== card.id) {
        throw new AmuxV4UnitDecisionError("reconfirm");
      }
      const preview = await tx.amuxIdeaTransferPreview.findUnique({
        where: { id: verified.previewId },
      });
      if (!preview || preview.ideaId !== choice.ideaId ||
          preview.chunkIndex !== unit.chunkIndex ||
          preview.state !== "completed") {
        throw new AmuxV4UnitDecisionError("reconfirm");
      }
      const scope = preview.sourceScopeApprovalId ?
        await tx.amuxIdeaSourceScopeApproval.findUnique({
          where: { id: preview.sourceScopeApprovalId },
          select: { id: true, ideaId: true, scopeDigest: true,
            scopeDigestKeyId: true },
        }) : null;
      if (preview.sourceScopeApprovalId &&
          (!scope || scope.ideaId !== choice.ideaId)) {
        throw new AmuxV4UnitDecisionError("reconfirm");
      }
      const duplicates = await scanner(tx, { unitId: unit.id,
        proposal: verified.proposal, featureNodeId: choice.featureNodeId });
      const snapshot = assembleAmuxV4CardLink({ ideaId: choice.ideaId,
        decisionId, prepareRequestId: choice.prepareRequestId,
        actorUserId, ownerSession, unit: { id: unit.id,
          localRef: unit.localRef!, bodyDigest: unit.bodyDigest,
          bodyDigestKeyId: unit.bodyDigestKeyId },
        proposal: verified.proposal,
        preview: { id: preview.id, payloadDigest: preview.payloadDigest,
          payloadDigestKeyId: preview.payloadDigestKeyId,
          scopeApprovalId: scope?.id ?? null,
          scopeDigest: scope?.scopeDigest ?? null,
          scopeDigestKeyId: scope?.scopeDigestKeyId ?? null },
        hierarchy: hierarchy as Parameters<typeof assembleAmuxV4CardLink>[0]["hierarchy"],
        target: { kind: "card", id: card.id,
          cardType: card.cardType as "story" | "task",
          storyKind: card.storyKind as "general" | "bug" | null,
          featureNodeId: choice.featureNodeId,
          sourceSystem: "admin-idea-v4", status: card.status as
            "backlog" | "todo" | "doing" | "review" | "done" | "blocked" | "cancelled",
          revision: card.revision, content: { digest: card.v4TitleDigest,
            keyId: card.v4TitleDigestKeyId } },
        sourceFeatureRef, duplicateScan: duplicates,
        decisionReason: choice.decisionReason, key: keys });
      if (!snapshot) throw new AmuxV4UnitDecisionError("reconfirm");
      const result = await commitAmuxV4UnitPrepare(tx, {
        session: input.session, request: input.request, snapshot,
        duplicateScan: duplicates, taskCost: null, digestKey: keys,
      });
      callbackReturned = true;
      return { ...result, draftUnitId: unit.id,
        title: verified.proposal.title,
        cardType: verified.proposal.cardType,
        targetCardId: card.id, targetRevision: card.revision,
        featureNodeId: choice.featureNodeId,
        targetCreated: false as const };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      maxWait: 5_000, timeout: 15_000 });
  } catch (error) {
    if (!callbackReturned && error instanceof AmuxV4UnitDecisionError) throw error;
    if (!callbackReturned && error instanceof AmuxCardDuplicateScanError) {
      throw new AmuxV4UnitDecisionError(error.code === "integrity_unavailable" ?
        "integrity_unavailable" : "reconfirm");
    }
    throw new AmuxV4UnitDecisionError("outcome_unknown");
  }
}

export async function consumeAmuxV4CardLink(input: {
  session: Session; request: Request; decisionId: string;
  consumeRequestId: string; confirmationDigest: string;
  browserNonce: string;
}) {
  const actorUserId = owner(input.session);
  await assertRecentAdminAuthentication(input.session);
  if (!amuxV4UnitWriteEnabled(process.env[AMUX_V4_UNIT_WRITE_ENV])) {
    throw new AmuxV4UnitDecisionError("write_disabled");
  }
  if (!ID.test(input.decisionId) || !UUID.test(input.consumeRequestId) ||
      !DIGEST.test(input.confirmationDigest)) {
    throw new AmuxV4UnitDecisionError("not_ready");
  }
  const prepared = await prisma.amuxIdeaUnitDecision.findFirst({ where: {
    id: input.decisionId, actorUserId,
  } });
  if (!prepared || prepared.action !== "link_existing_card" ||
      prepared.state !== "prepared" || prepared.outcomeUnknownAt !== null ||
      prepared.confirmationSnapshot === null ||
      !sameAmuxIdeaUnitConfirmation(input.confirmationDigest,
        prepared.confirmationDigest)) {
    throw new AmuxV4UnitDecisionError("reconfirm");
  }
  const snapshot = prepared.confirmationSnapshot as
    AmuxIdeaUnitConfirmationSnapshot;
  if (snapshot.action !== "link_existing_card" ||
      snapshot.target?.kind !== "card" ||
      snapshot.decisionId !== prepared.id ||
      snapshot.ideaId !== prepared.ideaId ||
      snapshot.draftUnitId !== prepared.draftUnitId) {
    throw new AmuxV4UnitDecisionError("reconfirm");
  }
  const verified = await readVerifiedAmuxCardProposal(input.session,
    prepared.ideaId, prepared.draftUnitId);
  const scanner = await loadAmuxCardDuplicateScanner();
  const keys = loadCurrentAmuxContentKeys(process.env);
  const browser = amuxV4UnitBrowserDigest({ decisionId: prepared.id,
    actorUserId, authenticatedAt: input.session.user?.authenticatedAt,
    nonce: input.browserNonce, key: keys });
  if (!sameAmuxIdeaUnitConfirmation(browser.digest,
      prepared.ownerSessionDigest) ||
      browser.keyId !== prepared.ownerSessionDigestKeyId) {
    throw new AmuxV4UnitDecisionError("reconfirm");
  }
  let callbackReturned = false;
  try {
    return await prisma.$transaction(async (tx) => {
      const result = await commitAmuxV4CardLink(tx, {
        session: input.session, request: input.request, snapshot,
        proposal: verified.proposal, consumeRequestId: input.consumeRequestId,
        keys, recalculate: (transaction) => scanner(transaction, {
          unitId: prepared.draftUnitId,
          proposal: verified.proposal,
          featureNodeId: snapshot.target?.kind === "card" ?
            snapshot.target.featureNodeId : "",
        }), context: { decisionId: prepared.id,
          ideaId: prepared.ideaId, draftUnitId: prepared.draftUnitId,
          actorUserId, recentOwnerStepUp: true,
          ownerSessionDigest: browser.digest,
          ownerSessionDigestKeyId: browser.keyId },
      });
      callbackReturned = true;
      return result;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      maxWait: 5_000, timeout: 15_000 });
  } catch (error) {
    if (!callbackReturned && error instanceof AmuxV4UnitDecisionError) throw error;
    if (!callbackReturned && error instanceof AmuxCardDuplicateScanError) {
      throw new AmuxV4UnitDecisionError(error.code === "integrity_unavailable" ?
        "integrity_unavailable" : "reconfirm");
    }
    await markAmuxV4UnitConsumeOutcomeUnknown({ session: input.session,
      decisionId: input.decisionId,
      consumeRequestId: input.consumeRequestId });
    throw new AmuxV4UnitDecisionError("outcome_unknown");
  }
}
