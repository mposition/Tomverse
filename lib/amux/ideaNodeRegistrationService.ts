import "server-only";

import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import type { Session } from "next-auth";

import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { assertRecentAdminAuthentication } from "@/lib/adminReauthentication";
import { prisma } from "@/lib/prisma";
import { AmuxNodeDuplicateScanError, loadAmuxNodeDuplicateScanner } from
  "./ideaNodeDuplicateScanService.ts";
import { assembleAmuxV4NodeConfirmation } from
  "./ideaNodeConfirmationSnapshotCore.ts";
import { loadCurrentAmuxContentKeys } from "./ideaKeyConfig.ts";
import { createAmuxContentKeyRing } from "./ideaKeyStore.ts";
import { amuxV4UnitBrowserDigest } from "./ideaUnitBrowserCore.ts";
import { readVerifiedAmuxNodeProposal } from
  "./ideaUnitProposalReadService.ts";
import { deriveAmuxIdeaUnitConfirmation,
  sameAmuxIdeaUnitConfirmation,
  type AmuxIdeaUnitConfirmationSnapshot } from
  "./ideaUnitConfirmationCore.ts";
import { AMUX_V4_UNIT_WRITE_ENV, AmuxV4DuplicateReasonRequired,
  AmuxV4UnitDecisionError,
  amuxV4UnitWriteEnabled, commitAmuxV4NodeCreation,
  commitAmuxV4UnitPrepare,
  markAmuxV4UnitConsumeOutcomeUnknown } from "./ideaUnitDecisionStore.ts";

const ID = /^[A-Za-z0-9_-]{8,80}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
type Node = AmuxIdeaUnitConfirmationSnapshot["hierarchy"][number];

function owner(session: Session) {
  const id = session.user?.id;
  if (!id || !isAdminSession(session) || getAdminRole(session) !== "owner") {
    throw new AmuxV4UnitDecisionError("forbidden");
  }
  return id;
}

/** Build an exact approved ancestor path. A node with a forged revision or
 * an archived parent cannot become a registration target. */
export async function approvedAncestors(tx: Prisma.TransactionClient,
  parentNodeId: string | null): Promise<Node[]> {
  const reversed: Node[] = [];
  let cursor = parentNodeId;
  while (cursor !== null && reversed.length < 3) {
    const row = await tx.amuxPortfolioNode.findUnique({ where: { id: cursor } });
    if (!row || row.state !== "active") {
      throw new AmuxV4UnitDecisionError("reconfirm");
    }
    const revision = await tx.amuxPortfolioNodeRevision.findUnique({
      where: { nodeId_revision: { nodeId: row.id,
        revision: row.revision } },
    });
    const approval = revision ? await tx.amuxIdeaUnitDecision.findUnique({
      where: { id: revision.decisionId },
      select: { action: true, state: true, resolvedNodeId: true },
    }) : null;
    if (!revision || revision.contentDigest !== row.contentDigest ||
        revision.contentDigestKeyId !== row.contentDigestKeyId ||
        approval?.action !== "create_node" || approval.state !== "consumed" ||
        approval.resolvedNodeId !== row.id) {
      throw new AmuxV4UnitDecisionError("reconfirm");
    }
    reversed.push({ id: row.id,
      level: row.level as Node["level"], parentId: row.parentId,
      revision: row.revision, content: { digest: row.contentDigest,
        keyId: row.contentDigestKeyId }, state: "active",
      approvedDecisionId: revision.decisionId });
    cursor = row.parentId;
  }
  if (cursor !== null) throw new AmuxV4UnitDecisionError("reconfirm");
  const path = reversed.reverse();
  const levels = ["initiative", "epic", "feature"];
  if (path.some((entry, index) => entry.level !== levels[index] ||
      entry.parentId !== (path[index - 1]?.id ?? null))) {
    throw new AmuxV4UnitDecisionError("reconfirm");
  }
  return path;
}

export async function prepareAmuxV4NodeCreation(input: {
  session: Session; request: Request; browserNonce: string;
  choice: { ideaId: string; draftUnitId: string;
    parentNodeId: string | null; prepareRequestId: string;
    decisionReason: string | null };
}) {
  const actorUserId = owner(input.session);
  await assertRecentAdminAuthentication(input.session);
  if (!amuxV4UnitWriteEnabled(process.env[AMUX_V4_UNIT_WRITE_ENV])) {
    throw new AmuxV4UnitDecisionError("write_disabled");
  }
  const choice = input.choice;
  if (!ID.test(choice.ideaId) || !ID.test(choice.draftUnitId) ||
      (choice.parentNodeId !== null && !ID.test(choice.parentNodeId)) ||
      !UUID.test(choice.prepareRequestId) ||
      (choice.decisionReason !== null &&
        (choice.decisionReason.length < 3 || choice.decisionReason.length > 500 ||
          choice.decisionReason !== choice.decisionReason.trim()))) {
    throw new AmuxV4UnitDecisionError("not_ready");
  }
  const verified = await readVerifiedAmuxNodeProposal(input.session,
    choice.ideaId, choice.draftUnitId);
  const scanner = await loadAmuxNodeDuplicateScanner();
  const keys = loadCurrentAmuxContentKeys(process.env);
  const decisionId = randomUUID();
  const nodeId = randomUUID();
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
      const unit = await tx.amuxIdeaDraftUnit.findFirst({ where: {
        id: choice.draftUnitId, ideaId: choice.ideaId, actorUserId },
        select: { id: true, localRef: true, unitKind: true, state: true,
          bodyDigest: true, bodyDigestKeyId: true, expiresAt: true,
          chunkIndex: true },
      });
      if (!unit || unit.state !== "proposed" || unit.unitKind !== "node" ||
          unit.localRef !== verified.unit.localRef ||
          unit.bodyDigest !== verified.unit.bodyDigest ||
          unit.bodyDigestKeyId !== verified.unit.bodyDigestKeyId ||
          unit.chunkIndex !== verified.unit.chunkIndex ||
          unit.expiresAt.getTime() !== verified.unit.expiresAt.getTime()) {
        throw new AmuxV4UnitDecisionError("reconfirm");
      }
      const hierarchy = await approvedAncestors(tx, choice.parentNodeId);
      if (hierarchy.length !== (["initiative", "epic", "feature"] as const)
        .indexOf(verified.proposal.level)) {
        throw new AmuxV4UnitDecisionError("reconfirm");
      }
      let sourceParentRef = choice.parentNodeId;
      if (verified.proposal.parentRef !== choice.parentNodeId) {
        const sourceUnit = await tx.amuxIdeaDraftUnit.findFirst({ where: {
          ideaId: choice.ideaId, actorUserId,
          localRef: verified.proposal.parentRef ?? "", unitKind: "node",
          state: "approved",
        }, select: { id: true } });
        const decision = sourceUnit ? await tx.amuxIdeaUnitDecision.findFirst({
          where: { draftUnitId: sourceUnit.id, state: "consumed",
            OR: [{ resolvedNodeId: choice.parentNodeId ?? "" },
              { linkedNodeId: choice.parentNodeId ?? "" }] },
          select: { id: true },
        }) : null;
        if (!decision) throw new AmuxV4UnitDecisionError("reconfirm");
        sourceParentRef = verified.proposal.parentRef;
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
      if (preview.sourceScopeApprovalId &&
          (!scope || scope.ideaId !== choice.ideaId)) {
        throw new AmuxV4UnitDecisionError("reconfirm");
      }
      const duplicates = await scanner(tx, { unitId: unit.id,
        title: verified.proposal.title, level: verified.proposal.level,
        parentId: choice.parentNodeId });
      if (duplicates.candidates.length > 0 && choice.decisionReason === null) {
        throw new AmuxV4DuplicateReasonRequired(
          duplicates.candidates.map((candidate) => candidate.id));
      }
      const snapshot = assembleAmuxV4NodeConfirmation({
        ideaId: choice.ideaId, decisionId,
        prepareRequestId: choice.prepareRequestId,
        actorUserId, ownerSession, nodeId,
        unit: { id: unit.id, localRef: unit.localRef!,
          bodyDigest: unit.bodyDigest,
          bodyDigestKeyId: unit.bodyDigestKeyId },
        proposal: verified.proposal,
        preview: { id: preview.id, payloadDigest: preview.payloadDigest,
          payloadDigestKeyId: preview.payloadDigestKeyId,
          scopeApprovalId: scope?.id ?? null,
          scopeDigest: scope?.scopeDigest ?? null,
          scopeDigestKeyId: scope?.scopeDigestKeyId ?? null },
        hierarchy, sourceParentRef, duplicateScan: duplicates,
        decisionReason: choice.decisionReason, key: keys,
      });
      if (!snapshot) throw new AmuxV4UnitDecisionError("reconfirm");
      const result = await commitAmuxV4UnitPrepare(tx, {
        session: input.session, request: input.request,
        snapshot, duplicateScan: duplicates, taskCost: null,
        digestKey: keys,
      });
      callbackReturned = true;
      return { ...result, draftUnitId: unit.id,
        title: verified.proposal.title, level: verified.proposal.level,
        parentNodeId: choice.parentNodeId, nodeId,
        duplicateCandidateIds: duplicates.candidates.map((item) => item.id),
        executionAuthorized: false as const };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      maxWait: 5_000, timeout: 15_000 });
  } catch (error) {
    if (!callbackReturned && error instanceof AmuxV4UnitDecisionError) throw error;
    if (!callbackReturned && error instanceof AmuxNodeDuplicateScanError) {
      throw new AmuxV4UnitDecisionError(error.code === "integrity_unavailable" ?
        "integrity_unavailable" : "reconfirm");
    }
    throw new AmuxV4UnitDecisionError("outcome_unknown");
  }
}

export async function consumeAmuxV4NodeCreation(input: {
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
      !/^[a-f0-9]{64}$/.test(input.confirmationDigest)) {
    throw new AmuxV4UnitDecisionError("not_ready");
  }
  const prepared = await prisma.amuxIdeaUnitDecision.findFirst({ where: {
    id: input.decisionId, actorUserId },
  });
  if (!prepared || prepared.action !== "create_node" ||
      prepared.state !== "prepared" ||
      prepared.outcomeUnknownAt !== null ||
      prepared.confirmationSnapshot === null ||
      !sameAmuxIdeaUnitConfirmation(input.confirmationDigest,
        prepared.confirmationDigest)) {
    throw new AmuxV4UnitDecisionError("reconfirm");
  }
  const snapshot = prepared.confirmationSnapshot as
    AmuxIdeaUnitConfirmationSnapshot;
  if (snapshot.action !== "create_node" || !snapshot.nodeProposal ||
      snapshot.decisionId !== prepared.id ||
      snapshot.ideaId !== prepared.ideaId ||
      snapshot.draftUnitId !== prepared.draftUnitId) {
    throw new AmuxV4UnitDecisionError("reconfirm");
  }
  const verified = await readVerifiedAmuxNodeProposal(input.session,
    prepared.ideaId, prepared.draftUnitId);
  const scanner = await loadAmuxNodeDuplicateScanner();
  const digestKey = loadCurrentAmuxContentKeys(process.env);
  const browser = amuxV4UnitBrowserDigest({ decisionId: prepared.id,
    actorUserId, authenticatedAt: input.session.user?.authenticatedAt,
    nonce: input.browserNonce, key: digestKey });
  if (!sameAmuxIdeaUnitConfirmation(browser.digest,
      prepared.ownerSessionDigest) ||
      browser.keyId !== prepared.ownerSessionDigestKeyId) {
    throw new AmuxV4UnitDecisionError("reconfirm");
  }
  let keys;
  try {
    keys = await createAmuxContentKeyRing([
      { ideaId: prepared.ideaId, purpose: "analysis_draft",
        subjectId: prepared.draftUnitId },
    ], [{ ideaId: prepared.ideaId, purpose: "node_content",
      subjectId: snapshot.nodeProposal.id }]);
  } catch { throw new AmuxV4UnitDecisionError("integrity_unavailable"); }
  let callbackReturned = false;
  try {
    return await prisma.$transaction(async (tx) => {
      const current = deriveAmuxIdeaUnitConfirmation(snapshot, digestKey,
        snapshot.duplicates, null);
      if (!current.ok || !sameAmuxIdeaUnitConfirmation(
        current.confirmationDigest, prepared.confirmationDigest)) {
        throw new AmuxV4UnitDecisionError("reconfirm");
      }
      const result = await commitAmuxV4NodeCreation(tx, {
        session: input.session, request: input.request,
        snapshot, proposal: verified.proposal,
        consumeRequestId: input.consumeRequestId, keys,
        recalculate: (transaction) => scanner(transaction, {
          unitId: prepared.draftUnitId, title: verified.proposal.title,
          level: verified.proposal.level,
          parentId: snapshot.nodeProposal?.parentId ?? null,
        }),
        context: { decisionId: prepared.id, ideaId: prepared.ideaId,
          draftUnitId: prepared.draftUnitId, actorUserId,
          recentOwnerStepUp: true,
          ownerSessionDigest: browser.digest,
          ownerSessionDigestKeyId: browser.keyId },
      });
      callbackReturned = true;
      return { ...result, executionAuthorized: false as const };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      maxWait: 5_000, timeout: 15_000 });
  } catch (error) {
    if (!callbackReturned && error instanceof AmuxV4UnitDecisionError) throw error;
    if (!callbackReturned && error instanceof AmuxNodeDuplicateScanError) {
      throw new AmuxV4UnitDecisionError(error.code === "integrity_unavailable" ?
        "integrity_unavailable" : "reconfirm");
    }
    await markAmuxV4UnitConsumeOutcomeUnknown({ session: input.session,
      decisionId: input.decisionId,
      consumeRequestId: input.consumeRequestId });
    throw new AmuxV4UnitDecisionError("outcome_unknown");
  }
}
