import "server-only";

import { Prisma } from "@prisma/client";
import type { Session } from "next-auth";

import { adminAuditIntegrityKeys } from "@/lib/adminAuditIntegrityCore";
import { prisma } from "@/lib/prisma";
import { loadCurrentAmuxContentKeys } from "./ideaKeyConfig.ts";
import { commitAmuxRootNodeConsume, commitAmuxRootNodePrepare,
  commitAmuxEpicNodeConsume, commitAmuxEpicNodePrepare,
  commitAmuxRootNodeUnknown, commitAmuxRootNodeNoCommitConfirmed,
  AmuxNodeCreateError,
  type AmuxNodeCreatePrepare, type AmuxNodeCreateConsume } from
  "./ideaNodeCreateService.ts";
import { readAmuxRootNodeDecision } from "./ideaNodeDecisionReadService.ts";
import { amuxUnitOwnerId, AmuxUnitRejectError } from
  "./ideaUnitRejectService.ts";
import { AMUX_V4_NODE_CREATE_READ_ENV, AMUX_V4_NODE_CREATE_WRITE_ENV,
  amuxV4NodeCreateReadPermitted, amuxV4NodeCreateWritePermitted,
  amuxRootNodeNeedsCommitReadback, amuxRootNodeKnownRollbackCode,
  amuxRootNodeReadbackProvesExpiry } from
  "./ideaNodeCreateCore.ts";

function beforeRecovery(session: Session) {
  try { amuxUnitOwnerId(session); }
  catch (error) {
    if (error instanceof AmuxUnitRejectError) {
      throw new AmuxNodeCreateError(error.code === "reconfirm"
        ? "reconfirm" : "not_found");
    }
    throw error;
  }
  if (!amuxV4NodeCreateReadPermitted(process.env[AMUX_V4_NODE_CREATE_READ_ENV]) ||
      !amuxV4NodeCreateWritePermitted(process.env[AMUX_V4_NODE_CREATE_WRITE_ENV])) {
    throw new AmuxNodeCreateError("write_disabled");
  }
  if (adminAuditIntegrityKeys(process.env).length === 0) {
    throw new AmuxNodeCreateError("integrity_unavailable");
  }
}

function beforeWrite(session: Session) {
  beforeRecovery(session);
  try { return loadCurrentAmuxContentKeys(process.env); }
  catch { throw new AmuxNodeCreateError("integrity_unavailable"); }
}

function knownPreCommitRefusal(error: unknown,
  phase: "prepare" | "consume"): AmuxNodeCreateError | null {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return null;
  if (error.code === "P2002") {
    return new AmuxNodeCreateError(phase === "prepare"
      ? "already_prepared" : "reconfirm");
  }
  if (error.code === "P2004") return new AmuxNodeCreateError("integrity_unavailable");
  return null;
}

async function prepareAmuxNode(session: Session, request: Request,
  choice: AmuxNodeCreatePrepare, level: "initiative" | "epic") {
  const keys = beforeWrite(session);
  let callbackReturned = false;
  const pending: { result: Awaited<ReturnType<typeof commitAmuxRootNodePrepare>> | null } =
    { result: null };
  try {
    return await prisma.$transaction(async (tx) => {
      pending.result = await (level === "initiative"
        ? commitAmuxRootNodePrepare(tx, { session, request, choice, keys })
        : commitAmuxEpicNodePrepare(tx, { session, request, choice, keys }));
      callbackReturned = true;
      return pending.result;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      maxWait: 5_000, timeout: 15_000 });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError &&
        amuxRootNodeKnownRollbackCode(error.code)) {
      throw new AmuxNodeCreateError("reconfirm");
    }
    if (!amuxRootNodeNeedsCommitReadback(callbackReturned)) {
      if (error instanceof AmuxNodeCreateError) throw error;
      const known = knownPreCommitRefusal(error, "prepare");
      if (known) throw known;
      throw new AmuxNodeCreateError("integrity_unavailable");
    }
    try {
      const status = await readAmuxRootNodeDecision(session,
        choice.decisionId, choice.prepareRequestId, level);
      if (status.state === "prepared" && pending.result &&
          status.ideaId === choice.ideaId &&
          status.draftUnitId === choice.draftUnitId &&
          status.nodeId === choice.nodeId &&
          status.confirmationDigest === pending.result.confirmationDigest) {
        return pending.result;
      }
    } catch { /* An uncertain COMMIT is never retried. */ }
    throw new AmuxNodeCreateError("outcome_unknown");
  }
}

export const prepareAmuxRootNode = (session: Session, request: Request,
  choice: AmuxNodeCreatePrepare) => prepareAmuxNode(session, request,
    choice, "initiative");

export const prepareAmuxEpicNode = (session: Session, request: Request,
  choice: AmuxNodeCreatePrepare) => prepareAmuxNode(session, request,
    choice, "epic");

async function consumeAmuxNode(session: Session, request: Request,
  choice: AmuxNodeCreateConsume, level: "initiative" | "epic") {
  const keys = beforeWrite(session);
  let callbackReturned = false;
  try {
    return await prisma.$transaction(async (tx) => {
      const result = await (level === "initiative"
        ? commitAmuxRootNodeConsume(tx, { session, request, choice, keys })
        : commitAmuxEpicNodeConsume(tx, { session, request, choice, keys }));
      callbackReturned = true;
      return result;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      maxWait: 5_000, timeout: 15_000 });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError &&
        amuxRootNodeKnownRollbackCode(error.code)) {
      throw new AmuxNodeCreateError("reconfirm");
    }
    if (!amuxRootNodeNeedsCommitReadback(callbackReturned)) {
      if (error instanceof AmuxNodeCreateError) throw error;
      const known = knownPreCommitRefusal(error, "consume");
      if (known) throw known;
      throw new AmuxNodeCreateError("integrity_unavailable");
    }
    let definitelyExpired = false;
    try {
      const status = await readAmuxRootNodeDecision(session,
        choice.decisionId, choice.prepareRequestId, level);
      if (status.state === "created" &&
          status.draftUnitId === choice.draftUnitId &&
          status.nodeId === choice.nodeId &&
          status.confirmationDigest === choice.confirmationDigest &&
          status.consumeRequestId === choice.consumeRequestId) {
        return { decisionId: status.decisionId, nodeId: status.nodeId,
          state: "created" as const, auditId: status.auditId };
      }
      if (amuxRootNodeReadbackProvesExpiry(status, choice)) {
        definitelyExpired = true;
      }
      if (status.state === "prepared" &&
          status.ideaId === choice.ideaId &&
          status.draftUnitId === choice.draftUnitId &&
          status.nodeId === choice.nodeId &&
          status.confirmationDigest === choice.confirmationDigest) {
        await prisma.$transaction((tx) => commitAmuxRootNodeUnknown(tx, {
          actorUserId: amuxUnitOwnerId(session),
          decisionId: choice.decisionId,
          prepareRequestId: choice.prepareRequestId,
          consumeRequestId: choice.consumeRequestId,
        }), { maxWait: 5_000, timeout: 15_000 });
      }
    } catch { /* Exact-ID read-back remains the only recovery path. */ }
    if (definitelyExpired) throw new AmuxNodeCreateError("reconfirm");
    throw new AmuxNodeCreateError("outcome_unknown");
  }
}

export const consumeAmuxRootNode = (session: Session, request: Request,
  choice: AmuxNodeCreateConsume) => consumeAmuxNode(session, request,
    choice, "initiative");

export const consumeAmuxEpicNode = (session: Session, request: Request,
  choice: AmuxNodeCreateConsume) => consumeAmuxNode(session, request,
    choice, "epic");

async function confirmAmuxNodeNoCommit(session: Session,
  request: Request, decisionId: string, prepareRequestId: string,
  level: "initiative" | "epic") {
  beforeRecovery(session);
  let callbackReturned = false;
  try {
    return await prisma.$transaction(async (tx) => {
      const result = await commitAmuxRootNodeNoCommitConfirmed(tx,
        { session, request, decisionId, prepareRequestId }, level);
      callbackReturned = true;
      return result;
    }, { maxWait: 5_000, timeout: 15_000 });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError &&
        amuxRootNodeKnownRollbackCode(error.code)) {
      throw new AmuxNodeCreateError("reconfirm");
    }
    if (!amuxRootNodeNeedsCommitReadback(callbackReturned)) {
      if (error instanceof AmuxNodeCreateError) throw error;
      const known = knownPreCommitRefusal(error, "consume");
      if (known) throw known;
      throw new AmuxNodeCreateError("integrity_unavailable");
    }
    try {
      const status = await readAmuxRootNodeDecision(session,
        decisionId, prepareRequestId, level);
      if (status.state === "no_commit_confirmed" &&
          status.decisionId === decisionId) {
        return { decisionId, state: "no_commit_confirmed" as const,
          auditId: status.auditId };
      }
    } catch { /* No second owner decision after an uncertain COMMIT. */ }
    throw new AmuxNodeCreateError("outcome_unknown");
  }
}

export const confirmAmuxRootNodeNoCommit = (session: Session,
  request: Request, decisionId: string, prepareRequestId: string) =>
  confirmAmuxNodeNoCommit(session, request, decisionId, prepareRequestId,
    "initiative");

export const confirmAmuxEpicNodeNoCommit = (session: Session,
  request: Request, decisionId: string, prepareRequestId: string) =>
  confirmAmuxNodeNoCommit(session, request, decisionId, prepareRequestId,
    "epic");
