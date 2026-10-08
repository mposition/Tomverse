import "server-only";

import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import type { Session } from "next-auth";

import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { assertRecentAdminAuthentication } from "@/lib/adminReauthentication";
import { prisma } from "@/lib/prisma";
import { loadCurrentAmuxContentKeys } from "./ideaKeyConfig.ts";
import { approvedAncestors } from "./ideaNodeRegistrationService.ts";
import { AmuxNodeDuplicateScanError, loadAmuxNodeDuplicateScanner } from
  "./ideaNodeDuplicateScanService.ts";
import { assembleAmuxV4NodeSelection } from
  "./ideaNodeSelectionSnapshotCore.ts";
import { amuxV4UnitBrowserDigest } from "./ideaUnitBrowserCore.ts";
import { sameAmuxIdeaUnitConfirmation,
  type AmuxIdeaUnitConfirmationSnapshot } from
  "./ideaUnitConfirmationCore.ts";
import { readVerifiedAmuxNodeProposal } from
  "./ideaUnitProposalReadService.ts";
import { AMUX_V4_UNIT_WRITE_ENV, AmuxV4UnitDecisionError,
  amuxV4UnitWriteEnabled, commitAmuxV4NodeSelection,
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

export async function prepareAmuxV4NodeSelection(input: {
  session: Session; request: Request; browserNonce: string;
  choice: { ideaId: string; draftUnitId: string; targetNodeId: string;
    action: "select_existing_node" | "link_existing_node";
    decisionReason: string | null; prepareRequestId: string };
}) {
  const actorUserId = owner(input.session);
  await assertRecentAdminAuthentication(input.session);
  if (!amuxV4UnitWriteEnabled(process.env[AMUX_V4_UNIT_WRITE_ENV])) {
    throw new AmuxV4UnitDecisionError("write_disabled");
  }
  const choice = input.choice;
  if (!ID.test(choice.ideaId) || !ID.test(choice.draftUnitId) ||
      !ID.test(choice.targetNodeId) || !UUID.test(choice.prepareRequestId) ||
      !["select_existing_node", "link_existing_node"].includes(choice.action) ||
      (choice.action === "link_existing_node") !==
        (choice.decisionReason !== null) ||
      (choice.decisionReason !== null &&
        (choice.decisionReason.length < 3 ||
          choice.decisionReason.length > 500 ||
          choice.decisionReason !== choice.decisionReason.trim()))) {
    throw new AmuxV4UnitDecisionError("not_ready");
  }
  const verified = await readVerifiedAmuxNodeProposal(input.session,
    choice.ideaId, choice.draftUnitId);
  const scanner = await loadAmuxNodeDuplicateScanner();
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
          !unit || unit.state !== "proposed" || unit.unitKind !== "node" ||
          unit.localRef !== verified.unit.localRef ||
          unit.bodyDigest !== verified.unit.bodyDigest ||
          unit.bodyDigestKeyId !== verified.unit.bodyDigestKeyId ||
          unit.chunkIndex !== verified.unit.chunkIndex ||
          unit.expiresAt.getTime() !== verified.unit.expiresAt.getTime()) {
        throw new AmuxV4UnitDecisionError("reconfirm");
      }
      const path = await approvedAncestors(tx, choice.targetNodeId);
      const target = path.at(-1);
      if (!target || target.level !== verified.proposal.level) {
        throw new AmuxV4UnitDecisionError("reconfirm");
      }
      const hierarchy = path.slice(0, -1);
      let sourceParentRef = target.parentId;
      if (verified.proposal.parentRef !== target.parentId) {
        const sourceUnit = await tx.amuxIdeaDraftUnit.findFirst({ where: {
          ideaId: choice.ideaId, actorUserId,
          localRef: verified.proposal.parentRef ?? "", unitKind: "node",
          state: "approved",
        }, select: { id: true } });
        const mapping = sourceUnit ? await tx.amuxIdeaUnitDecision.findFirst({
          where: { draftUnitId: sourceUnit.id, state: "consumed",
            OR: [{ resolvedNodeId: target.parentId ?? "" },
              { linkedNodeId: target.parentId ?? "" }] },
          select: { id: true },
        }) : null;
        if (!mapping) throw new AmuxV4UnitDecisionError("reconfirm");
        sourceParentRef = verified.proposal.parentRef;
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
        title: verified.proposal.title, level: verified.proposal.level,
        parentId: target.parentId });
      const snapshot = assembleAmuxV4NodeSelection({ ideaId: choice.ideaId,
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
        hierarchy, target, sourceParentRef, duplicateScan: duplicates,
        action: choice.action, decisionReason: choice.decisionReason,
        key: keys });
      if (!snapshot) throw new AmuxV4UnitDecisionError("reconfirm");
      const result = await commitAmuxV4UnitPrepare(tx, {
        session: input.session, request: input.request,
        snapshot, duplicateScan: duplicates, taskCost: null,
        digestKey: keys,
      });
      callbackReturned = true;
      return { ...result, draftUnitId: unit.id, action: choice.action,
        targetNodeId: target.id, targetRevision: target.revision,
        level: target.level, title: verified.proposal.title,
        targetCreated: false as const };
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

export async function consumeAmuxV4NodeSelection(input: {
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
  if (!prepared || !["select_existing_node", "link_existing_node"]
    .includes(prepared.action) || prepared.state !== "prepared" ||
      prepared.outcomeUnknownAt !== null ||
      prepared.confirmationSnapshot === null ||
      !sameAmuxIdeaUnitConfirmation(input.confirmationDigest,
        prepared.confirmationDigest)) {
    throw new AmuxV4UnitDecisionError("reconfirm");
  }
  const snapshot = prepared.confirmationSnapshot as
    AmuxIdeaUnitConfirmationSnapshot;
  if (snapshot.action !== prepared.action ||
      snapshot.target?.kind !== "node" ||
      snapshot.decisionId !== prepared.id ||
      snapshot.ideaId !== prepared.ideaId ||
      snapshot.draftUnitId !== prepared.draftUnitId) {
    throw new AmuxV4UnitDecisionError("reconfirm");
  }
  const verified = await readVerifiedAmuxNodeProposal(input.session,
    prepared.ideaId, prepared.draftUnitId);
  const scanner = await loadAmuxNodeDuplicateScanner();
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
      const result = await commitAmuxV4NodeSelection(tx, {
        session: input.session, request: input.request, snapshot,
        proposal: verified.proposal, consumeRequestId: input.consumeRequestId,
        keys, recalculate: (transaction) => scanner(transaction, {
          unitId: prepared.draftUnitId, title: verified.proposal.title,
          level: verified.proposal.level,
          parentId: snapshot.target?.kind === "node" ?
            snapshot.target.parentId : null,
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
