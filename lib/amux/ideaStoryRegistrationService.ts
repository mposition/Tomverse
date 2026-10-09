import "server-only";

import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import type { Session } from "next-auth";

import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { assertRecentAdminAuthentication } from "@/lib/adminReauthentication";
import { prisma } from "@/lib/prisma";
import { AmuxCardDuplicateScanError, loadAmuxCardDuplicateScanner } from
  "./ideaCardDuplicateScanService.ts";
import { loadCurrentAmuxContentKeys } from "./ideaKeyConfig.ts";
import { amuxV4UnitBrowserDigest } from "./ideaUnitBrowserCore.ts";
import { createAmuxContentKeyRing } from "./ideaKeyStore.ts";
import { readVerifiedAmuxCardProposal } from "./ideaUnitProposalReadService.ts";
import { assembleAmuxV4StoryConfirmation } from
  "./ideaStoryConfirmationSnapshotCore.ts";
import { assembleAmuxV4TaskConfirmation } from
  "./ideaTaskConfirmationSnapshotCore.ts";
import { resolveAmuxV4TaskReferences } from
  "./ideaTaskReferenceService.ts";
import { calculateCurrentApprovedAmuxV4TaskCost,
  AmuxV4TaskCatalogApprovalError } from
  "./v4TaskCostCatalogApprovalService.ts";
import { AmuxV4DuplicateReasonRequired, AmuxV4UnitDecisionError,
  AMUX_V4_UNIT_WRITE_ENV,
  amuxV4UnitWriteEnabled, commitAmuxV4CardRegistration,
  commitAmuxV4UnitPrepare, markAmuxV4UnitConsumeOutcomeUnknown } from
  "./ideaUnitDecisionStore.ts";
import { deriveAmuxIdeaUnitConfirmation,
  sameAmuxIdeaUnitConfirmation,
  type AmuxIdeaUnitConfirmationSnapshot } from
  "./ideaUnitConfirmationCore.ts";

export type AmuxV4StoryPrepareChoice = {
  ideaId: string;
  draftUnitId: string;
  featureNodeId: string;
  prepareRequestId: string;
  decisionReason: string | null;
  cardType?: "story" | "task";
  publicPrDisclosureApproved?: boolean;
};

const ID = /^[A-Za-z0-9_-]{8,80}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

/** One card under an approved Feature. A Task additionally needs an approved
 * versioned Agent-only cost catalog and resolved Story/dependency references. */
export async function prepareAmuxV4CardRegistration(input: {
  session: Session; request: Request; choice: AmuxV4StoryPrepareChoice;
  browserNonce: string;
}) {
  const actorUserId = input.session.user?.id;
  if (!actorUserId || !isAdminSession(input.session) ||
      getAdminRole(input.session) !== "owner") {
    throw new AmuxV4UnitDecisionError("forbidden");
  }
  await assertRecentAdminAuthentication(input.session);
  if (!amuxV4UnitWriteEnabled(process.env[AMUX_V4_UNIT_WRITE_ENV])) {
    throw new AmuxV4UnitDecisionError("write_disabled");
  }
  const choice = input.choice;
  if (!ID.test(choice.ideaId) || !ID.test(choice.draftUnitId) ||
      !ID.test(choice.featureNodeId) || !UUID.test(choice.prepareRequestId) ||
      (choice.decisionReason !== null &&
        (choice.decisionReason.length < 3 || choice.decisionReason.length > 500 ||
          choice.decisionReason !== choice.decisionReason.trim())) ||
      (choice.publicPrDisclosureApproved === true && choice.cardType !== "task")) {
    throw new AmuxV4UnitDecisionError("not_ready");
  }
  const verified = await readVerifiedAmuxCardProposal(input.session,
    choice.ideaId, choice.draftUnitId);
  if (verified.proposal.cardType !== (choice.cardType ?? "story")) {
    throw new AmuxV4UnitDecisionError("not_ready");
  }
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
      const idea = await tx.amuxIdeaSubmission.findFirst({
        where: { id: choice.ideaId, actorUserId },
        select: { id: true, state: true },
      });
      if (!idea || !["analyzing", "awaiting_owner"].includes(idea.state)) {
        throw new AmuxV4UnitDecisionError("not_ready");
      }
      const unit = await tx.amuxIdeaDraftUnit.findFirst({
        where: { id: choice.draftUnitId, ideaId: choice.ideaId, actorUserId },
        select: { id: true, localRef: true, unitKind: true, state: true,
          bodyDigest: true, bodyDigestKeyId: true, expiresAt: true,
          chunkIndex: true },
      });
      if (!unit || unit.state !== "proposed" || unit.unitKind !== "card" ||
          unit.localRef !== verified.unit.localRef ||
          unit.bodyDigest !== verified.unit.bodyDigest ||
          unit.bodyDigestKeyId !== verified.unit.bodyDigestKeyId ||
          unit.chunkIndex !== verified.unit.chunkIndex ||
          unit.expiresAt.getTime() !== verified.unit.expiresAt.getTime()) {
        throw new AmuxV4UnitDecisionError("reconfirm");
      }
      const feature = await tx.amuxPortfolioNode.findUnique({
        where: { id: choice.featureNodeId },
      });
      if (!feature || feature.level !== "feature" ||
          feature.state !== "active" || !feature.parentId) {
        throw new AmuxV4UnitDecisionError("reconfirm");
      }
      const epic = await tx.amuxPortfolioNode.findUnique({
        where: { id: feature.parentId },
      });
      const initiative = epic?.parentId ? await tx.amuxPortfolioNode.findUnique({
        where: { id: epic.parentId },
      }) : null;
      if (!epic || !initiative || epic.level !== "epic" ||
          initiative.level !== "initiative" || initiative.parentId !== null ||
          epic.state !== "active" || initiative.state !== "active") {
        throw new AmuxV4UnitDecisionError("reconfirm");
      }
      const nodes = [initiative, epic, feature] as const;
      const revisions = await Promise.all(nodes.map((node) =>
        tx.amuxPortfolioNodeRevision.findUnique({ where: {
          nodeId_revision: { nodeId: node.id, revision: node.revision },
        } })));
      if (revisions.some((revision, index) => !revision ||
          revision.contentDigest !== nodes[index].contentDigest ||
          revision.contentDigestKeyId !== nodes[index].contentDigestKeyId)) {
        throw new AmuxV4UnitDecisionError("reconfirm");
      }
      let sourceFeatureRef = choice.featureNodeId;
      if (verified.proposal.featureRef !== choice.featureNodeId) {
        const sourceUnit = await tx.amuxIdeaDraftUnit.findFirst({ where: {
          ideaId: choice.ideaId, actorUserId,
          localRef: verified.proposal.featureRef, unitKind: "node",
          state: "approved",
        }, select: { id: true } });
        const sourceDecision = sourceUnit ? await tx.amuxIdeaUnitDecision.findFirst({
          where: { draftUnitId: sourceUnit.id, state: "consumed",
            OR: [{ resolvedNodeId: choice.featureNodeId },
              { linkedNodeId: choice.featureNodeId }] },
          select: { id: true },
        }) : null;
        if (!sourceDecision) throw new AmuxV4UnitDecisionError("reconfirm");
        sourceFeatureRef = verified.proposal.featureRef;
      }
      const preview = await tx.amuxIdeaTransferPreview.findUnique({
        where: { id: verified.previewId },
      });
      if (!preview || preview.state !== "completed" ||
          preview.ideaId !== choice.ideaId ||
          preview.chunkIndex !== unit.chunkIndex) {
        throw new AmuxV4UnitDecisionError("reconfirm");
      }
      const scope = preview.sourceScopeApprovalId ?
        await tx.amuxIdeaSourceScopeApproval.findUnique({
          where: { id: preview.sourceScopeApprovalId },
          select: { id: true, scopeDigest: true,
            scopeDigestKeyId: true, ideaId: true },
        }) : null;
      if (preview.sourceScopeApprovalId && (!scope || scope.ideaId !== choice.ideaId)) {
        throw new AmuxV4UnitDecisionError("reconfirm");
      }
      const duplicates = await scanner(tx, { unitId: unit.id,
        proposal: verified.proposal, featureNodeId: feature.id });
      if (duplicates.candidates.length > 0 && choice.decisionReason === null) {
        throw new AmuxV4DuplicateReasonRequired(
          duplicates.candidates.map((candidate) => candidate.id));
      }
      const common = {
        ideaId: choice.ideaId, decisionId, prepareRequestId: choice.prepareRequestId,
        actorUserId, ownerSession,
        unit: { id: unit.id, localRef: unit.localRef!,
          bodyDigest: unit.bodyDigest, bodyDigestKeyId: unit.bodyDigestKeyId },
        proposal: verified.proposal,
        preview: { id: preview.id, payloadDigest: preview.payloadDigest,
          payloadDigestKeyId: preview.payloadDigestKeyId,
          scopeApprovalId: scope?.id ?? null, scopeDigest: scope?.scopeDigest ?? null,
          scopeDigestKeyId: scope?.scopeDigestKeyId ?? null },
        hierarchy: nodes.map((node, index) => ({ id: node.id,
          level: node.level as "initiative" | "epic" | "feature",
          parentId: node.parentId, revision: node.revision,
          content: { digest: node.contentDigest,
            keyId: node.contentDigestKeyId }, state: "active" as const,
          approvedDecisionId: revisions[index]!.decisionId })) as
            Parameters<typeof assembleAmuxV4StoryConfirmation>[0]["hierarchy"],
        sourceFeatureRef, duplicateScan: duplicates,
        decisionReason: choice.decisionReason, key: keys,
      };
      let taskCost = null;
      let snapshot: AmuxIdeaUnitConfirmationSnapshot | null;
      if (verified.proposal.cardType === "task") {
        if (!verified.proposal.taskRole || !verified.proposal.executionGrade) {
          throw new AmuxV4UnitDecisionError("not_ready");
        }
        const refs = await resolveAmuxV4TaskReferences(tx, {
          ideaId: choice.ideaId, actorUserId, proposal: verified.proposal,
          featureNodeId: feature.id,
        });
        try {
          const approved = await calculateCurrentApprovedAmuxV4TaskCost(tx,
            verified.proposal.taskRole, verified.proposal.executionGrade);
          taskCost = { ok: true as const, receipt: approved.receipt };
          snapshot = assembleAmuxV4TaskConfirmation({ ...common, ...refs,
            costReceipt: approved.receipt,
            publicPrDisclosureApproved:
              choice.publicPrDisclosureApproved === true });
        } catch (error) {
          if (error instanceof AmuxV4TaskCatalogApprovalError) {
            throw new AmuxV4UnitDecisionError("not_ready");
          }
          throw error;
        }
      } else {
        snapshot = assembleAmuxV4StoryConfirmation(common);
      }
      if (!snapshot) throw new AmuxV4UnitDecisionError("reconfirm");
      const result = await commitAmuxV4UnitPrepare(tx, { session: input.session,
        request: input.request, snapshot, duplicateScan: duplicates,
        taskCost, digestKey: keys });
      callbackReturned = true;
      return { ...result, draftUnitId: unit.id, title: verified.proposal.title,
        cardType: verified.proposal.cardType,
        storyKind: verified.proposal.storyKind,
        featureNodeId: feature.id, duplicateCandidateIds:
          duplicates.candidates.map((candidate) => candidate.id),
        taskCostReceipt: taskCost?.receipt ?? null,
        publicPrDisclosureApproved: snapshot.card?.task?.publicPrDisclosureApproved === true,
        backlogOnly: true as const, executionAuthorized: false as const };
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

/** Consume one exact prepared Story. The owner-selected digest is compared
 * before creating external content keys, then checked again in the DB tx. */
export async function consumeAmuxV4CardRegistration(input: {
  session: Session; request: Request; decisionId: string;
  consumeRequestId: string; confirmationDigest: string;
  browserNonce: string;
}) {
  const actorUserId = input.session.user?.id;
  if (!actorUserId || !isAdminSession(input.session) ||
      getAdminRole(input.session) !== "owner") {
    throw new AmuxV4UnitDecisionError("forbidden");
  }
  await assertRecentAdminAuthentication(input.session);
  if (!amuxV4UnitWriteEnabled(process.env[AMUX_V4_UNIT_WRITE_ENV])) {
    throw new AmuxV4UnitDecisionError("write_disabled");
  }
  if (!ID.test(input.decisionId) || !UUID.test(input.consumeRequestId) ||
      !/^[a-f0-9]{64}$/.test(input.confirmationDigest)) {
    throw new AmuxV4UnitDecisionError("not_ready");
  }
  const prepared = await prisma.amuxIdeaUnitDecision.findFirst({ where: {
    id: input.decisionId, actorUserId,
  } });
  if (!prepared) throw new AmuxV4UnitDecisionError("not_found");
  if (prepared.state !== "prepared" || prepared.action !== "register_card" ||
      prepared.outcomeUnknownAt !== null ||
      !sameAmuxIdeaUnitConfirmation(input.confirmationDigest,
        prepared.confirmationDigest) || prepared.confirmationSnapshot === null) {
    throw new AmuxV4UnitDecisionError("reconfirm");
  }
  const snapshot = prepared.confirmationSnapshot as
    AmuxIdeaUnitConfirmationSnapshot;
  if (!snapshot.card ||
      snapshot.decisionId !== prepared.id ||
      snapshot.ideaId !== prepared.ideaId ||
      snapshot.draftUnitId !== prepared.draftUnitId) {
    throw new AmuxV4UnitDecisionError("reconfirm");
  }
  const verified = await readVerifiedAmuxCardProposal(input.session,
    prepared.ideaId, prepared.draftUnitId);
  if (verified.proposal.cardType !== snapshot.card.cardType) {
    throw new AmuxV4UnitDecisionError("reconfirm");
  }
  const scanner = await loadAmuxCardDuplicateScanner();
  const digestKey = loadCurrentAmuxContentKeys(process.env);
  const browser = amuxV4UnitBrowserDigest({ decisionId: prepared.id,
    actorUserId, authenticatedAt: input.session.user?.authenticatedAt,
    nonce: input.browserNonce, key: digestKey });
  if (!sameAmuxIdeaUnitConfirmation(browser.digest,
      prepared.ownerSessionDigest) ||
      browser.keyId !== prepared.ownerSessionDigestKeyId) {
    throw new AmuxV4UnitDecisionError("reconfirm");
  }
  const cardId = randomUUID();
  let keys;
  try {
    keys = await createAmuxContentKeyRing([
      { ideaId: prepared.ideaId, purpose: "analysis_draft",
        subjectId: prepared.draftUnitId },
    ], [
      { ideaId: prepared.ideaId, purpose: "card_title", subjectId: cardId },
      { ideaId: prepared.ideaId, purpose: "card_body", subjectId: cardId },
      ...(snapshot.card.cardType === "task" ? [{ ideaId: prepared.ideaId,
        purpose: "card_brief" as const, subjectId: cardId }] : []),
    ]);
  } catch { throw new AmuxV4UnitDecisionError("integrity_unavailable"); }
  let callbackReturned = false;
  try {
    return await prisma.$transaction(async (tx) => {
      const recalculate = async (transaction: Prisma.TransactionClient) => {
        let taskCost = null;
        if (verified.proposal.cardType === "task") {
          if (!verified.proposal.taskRole || !verified.proposal.executionGrade) {
            throw new AmuxV4UnitDecisionError("reconfirm");
          }
          const approved = await calculateCurrentApprovedAmuxV4TaskCost(transaction,
            verified.proposal.taskRole, verified.proposal.executionGrade);
          taskCost = { ok: true as const, receipt: approved.receipt };
        }
        return { duplicateScan: await scanner(transaction, {
          unitId: prepared.draftUnitId, proposal: verified.proposal,
          featureNodeId: snapshot.card!.featureNodeId,
        }), taskCost };
      };
      const current = deriveAmuxIdeaUnitConfirmation(snapshot, digestKey,
        snapshot.duplicates, snapshot.card?.cardType === "task" ?
          { ok: true, receipt: snapshot.card.task!.costReceipt } : null);
      if (!current.ok || !sameAmuxIdeaUnitConfirmation(current.confirmationDigest,
          prepared.confirmationDigest)) {
        throw new AmuxV4UnitDecisionError("reconfirm");
      }
      const result = await commitAmuxV4CardRegistration(tx, {
        session: input.session, request: input.request, snapshot,
        proposal: verified.proposal, cardId, consumeRequestId: input.consumeRequestId,
        keys, recalculate,
        context: { decisionId: prepared.id, ideaId: prepared.ideaId,
          draftUnitId: prepared.draftUnitId, actorUserId,
          recentOwnerStepUp: true,
          ownerSessionDigest: browser.digest,
          ownerSessionDigestKeyId: browser.keyId },
      });
      callbackReturned = true;
      return { ...result, status: "backlog" as const,
        owner: null, executionAuthorized: false as const };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      maxWait: 5_000, timeout: 15_000 });
  } catch (error) {
    if (!callbackReturned && error instanceof AmuxV4UnitDecisionError) throw error;
    if (!callbackReturned && error instanceof AmuxV4TaskCatalogApprovalError) {
      throw new AmuxV4UnitDecisionError("not_ready");
    }
    // The scanner throws inside the transaction callback, before any commit.
    // Prisma has rolled that callback back; it is not an unknown outcome.
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

export const prepareAmuxV4StoryRegistration = prepareAmuxV4CardRegistration;
export const consumeAmuxV4StoryRegistration = consumeAmuxV4CardRegistration;
