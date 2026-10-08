import "server-only";

import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import type { Session } from "next-auth";

import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { assertRecentAdminAuthentication } from "@/lib/adminReauthentication";
import { prisma } from "@/lib/prisma";
import { loadCurrentAmuxContentKeys } from "./ideaKeyConfig.ts";
import { amuxV4UnitBrowserDigest } from "./ideaUnitBrowserCore.ts";
import { sameAmuxIdeaUnitConfirmation,
  type AmuxIdeaUnitConfirmationSnapshot } from
  "./ideaUnitConfirmationCore.ts";
import { readVerifiedAmuxUnitProposal } from
  "./ideaUnitProposalReadService.ts";
import { assembleAmuxV4UnitRejection } from
  "./ideaUnitRejectionSnapshotCore.ts";
import { AmuxV4UnitDecisionError, AMUX_V4_UNIT_WRITE_ENV,
  amuxV4UnitWriteEnabled, commitAmuxV4UnitPrepare,
  commitAmuxV4UnitRejection,
  markAmuxV4UnitConsumeOutcomeUnknown } from "./ideaUnitDecisionStore.ts";

const ID = /^[A-Za-z0-9_-]{8,80}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const DIGEST = /^[a-f0-9]{64}$/;

/** Rejection is a separate owner choice, not cancellation of an approval. */
export async function prepareAmuxV4UnitRejection(input: {
  session: Session; request: Request; ideaId: string;
  draftUnitId: string; prepareRequestId: string; reason: string;
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
  if (!ID.test(input.ideaId) || !ID.test(input.draftUnitId) ||
      !UUID.test(input.prepareRequestId) ||
      input.reason !== input.reason.trim() ||
      input.reason.length < 3 || input.reason.length > 500) {
    throw new AmuxV4UnitDecisionError("not_ready");
  }
  const verified = await readVerifiedAmuxUnitProposal(input.session,
    input.ideaId, input.draftUnitId);
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
        id: input.ideaId, actorUserId,
      }, select: { state: true } });
      const unit = await tx.amuxIdeaDraftUnit.findFirst({ where: {
        id: input.draftUnitId, ideaId: input.ideaId, actorUserId,
      }, select: { id: true, localRef: true, state: true, unitKind: true,
        bodyDigest: true, bodyDigestKeyId: true, chunkIndex: true,
        expiresAt: true } });
      if (!idea || !["analyzing", "awaiting_owner"].includes(idea.state) ||
          !unit || unit.state !== "proposed" ||
          unit.unitKind !== verified.proposal.kind ||
          unit.localRef !== verified.unit.localRef ||
          unit.bodyDigest !== verified.unit.bodyDigest ||
          unit.bodyDigestKeyId !== verified.unit.bodyDigestKeyId ||
          unit.chunkIndex !== verified.unit.chunkIndex ||
          unit.expiresAt.getTime() !== verified.unit.expiresAt.getTime()) {
        throw new AmuxV4UnitDecisionError("reconfirm");
      }
      const preview = await tx.amuxIdeaTransferPreview.findUnique({
        where: { id: verified.previewId },
      });
      if (!preview || preview.ideaId !== input.ideaId ||
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
      if (preview.sourceScopeApprovalId && (!scope || scope.ideaId !== input.ideaId)) {
        throw new AmuxV4UnitDecisionError("reconfirm");
      }
      const snapshot = assembleAmuxV4UnitRejection({ ideaId: input.ideaId,
        decisionId, prepareRequestId: input.prepareRequestId, actorUserId,
        ownerSession, unit: { id: unit.id, localRef: unit.localRef!,
          bodyDigest: unit.bodyDigest, bodyDigestKeyId: unit.bodyDigestKeyId },
        proposal: verified.proposal,
        preview: { id: preview.id, payloadDigest: preview.payloadDigest,
          payloadDigestKeyId: preview.payloadDigestKeyId,
          scopeApprovalId: scope?.id ?? null,
          scopeDigest: scope?.scopeDigest ?? null,
          scopeDigestKeyId: scope?.scopeDigestKeyId ?? null },
        reason: input.reason, key: keys });
      if (!snapshot) throw new AmuxV4UnitDecisionError("reconfirm");
      const result = await commitAmuxV4UnitPrepare(tx, {
        session: input.session, request: input.request, snapshot,
        duplicateScan: null, taskCost: null, digestKey: keys,
      });
      callbackReturned = true;
      return { ...result, draftUnitId: unit.id,
        unitKind: unit.unitKind, targetCreated: false as const };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      maxWait: 5_000, timeout: 15_000 });
  } catch (error) {
    if (!callbackReturned && error instanceof AmuxV4UnitDecisionError) throw error;
    throw new AmuxV4UnitDecisionError("outcome_unknown");
  }
}

export async function consumeAmuxV4UnitRejection(input: {
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
      !DIGEST.test(input.confirmationDigest)) {
    throw new AmuxV4UnitDecisionError("not_ready");
  }
  const prepared = await prisma.amuxIdeaUnitDecision.findFirst({ where: {
    id: input.decisionId, actorUserId,
  } });
  if (!prepared) throw new AmuxV4UnitDecisionError("not_found");
  if (prepared.state !== "prepared" || prepared.action !== "reject_unit" ||
      prepared.outcomeUnknownAt !== null ||
      !sameAmuxIdeaUnitConfirmation(input.confirmationDigest,
        prepared.confirmationDigest) || prepared.confirmationSnapshot === null) {
    throw new AmuxV4UnitDecisionError("reconfirm");
  }
  const snapshot = prepared.confirmationSnapshot as
    AmuxIdeaUnitConfirmationSnapshot;
  if (snapshot.action !== "reject_unit" || snapshot.decisionId !== prepared.id ||
      snapshot.ideaId !== prepared.ideaId ||
      snapshot.draftUnitId !== prepared.draftUnitId) {
    throw new AmuxV4UnitDecisionError("reconfirm");
  }
  const verified = await readVerifiedAmuxUnitProposal(input.session,
    prepared.ideaId, prepared.draftUnitId);
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
      const result = await commitAmuxV4UnitRejection(tx, {
        session: input.session, request: input.request, snapshot,
        proposal: verified.proposal, consumeRequestId: input.consumeRequestId,
        keys, context: { decisionId: prepared.id, ideaId: prepared.ideaId,
          draftUnitId: prepared.draftUnitId, actorUserId,
          recentOwnerStepUp: true, ownerSessionDigest: browser.digest,
          ownerSessionDigestKeyId: browser.keyId },
      });
      callbackReturned = true;
      return result;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      maxWait: 5_000, timeout: 15_000 });
  } catch (error) {
    if (!callbackReturned && error instanceof AmuxV4UnitDecisionError) throw error;
    await markAmuxV4UnitConsumeOutcomeUnknown({ session: input.session,
      decisionId: input.decisionId,
      consumeRequestId: input.consumeRequestId });
    throw new AmuxV4UnitDecisionError("outcome_unknown");
  }
}
