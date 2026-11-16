import "server-only";

import type { Prisma } from "@prisma/client";
import type { Session } from "next-auth";

import { takeAuditChainLock, writeAdminAuditLog } from "@/lib/adminAudit";
import { prisma } from "@/lib/prisma";
import { AmuxLegacyCardOwnerError, assertAmuxLegacyCardOwner } from "./legacyCardOwnerService.ts";
import { amuxDatabaseDiagnosticCode } from "./readFailureCore.ts";
import {
  AmuxV4TaskCatalogApprovalError, calculateCurrentApprovedAmuxV4TaskCost,
} from "./v4TaskCostCatalogApprovalService.ts";
import {
  AMUX_V4_TASK_CEILING_REAPPROVED_ACTION, amuxV4TaskCeilingReapprovalOffer,
  type AmuxV4TaskCeilingReapprovalOffer, type AmuxV4TaskCeilingReapprovalRefusal,
} from "./v4TaskCeilingReapprovalCore.ts";
import { readAmuxV52TaskReceipt } from "./v52GradeReceipt.ts";

/**
 * The owner re-approves a registered Task's cost ceiling
 * (v4TaskCeilingReapprovalCore.ts): the receipt the catalog prices now, as
 * the owner was shown it, becomes the Task's approved receipt. One audit
 * entry by the administrator writer in the same transaction; the Task row,
 * its confirmation and every ledger stay as they are.
 */

const TASK_ID = /^[A-Za-z0-9_-]{1,64}$/;

type TaskFacts = {
  id: string; displayKey: string | null; sourceSystem: string; cardType: string;
  status: string; revision: number; taskRole: string | null; executionGrade: string | null;
  v4SourceApprovalId: string | null; activeDelivery: boolean; liveAttempt: boolean;
};

/** What the Task detail shows the owner: the ceiling in force and the one asked for. */
export type AmuxV4TaskCeilingReapprovalView = {
  eligible: boolean;
  refusal: AmuxV4TaskCeilingReapprovalRefusal | null;
  reason: string | null;
  approvedCeilingMicroUsd: string | null;
  currentCeilingMicroUsd: string | null;
  catalogDigest: string | null;
  maxAttempts: number | null;
  routes: Array<{ workerName: string; modelId: string; perAttemptMicroUsd: string; approved: boolean }>;
};

async function readTaskFacts(tx: Prisma.TransactionClient, taskId: string, lock: boolean) {
  const rows = lock ? await tx.$queryRaw<TaskFacts[]>`
      SELECT w."id", w."displayKey", w."sourceSystem", w."cardType", w."status", w."revision",
        w."taskRole", w."executionGrade", w."v4SourceApprovalId",
        EXISTS (SELECT 1 FROM "AmuxWorkDelivery" d WHERE d."taskId" = w."id"
          AND d."status" IN ('queued', 'leased')) AS "activeDelivery",
        EXISTS (SELECT 1 FROM "AmuxExecutionAttempt" a WHERE a."taskId" = w."id"
          AND a."endedAt" IS NULL) AS "liveAttempt"
      FROM "AmuxWorkItem" w WHERE w."id" = ${taskId}
      FOR UPDATE OF w NOWAIT` : await tx.$queryRaw<TaskFacts[]>`
      SELECT w."id", w."displayKey", w."sourceSystem", w."cardType", w."status", w."revision",
        w."taskRole", w."executionGrade", w."v4SourceApprovalId",
        EXISTS (SELECT 1 FROM "AmuxWorkDelivery" d WHERE d."taskId" = w."id"
          AND d."status" IN ('queued', 'leased')) AS "activeDelivery",
        EXISTS (SELECT 1 FROM "AmuxExecutionAttempt" a WHERE a."taskId" = w."id"
          AND a."endedAt" IS NULL) AS "liveAttempt"
      FROM "AmuxWorkItem" w WHERE w."id" = ${taskId}`;
  return rows[0] ?? null;
}

/** The confirmation receipt of the registration that made this Task. */
async function confirmationReceipt(tx: Prisma.TransactionClient, task: TaskFacts): Promise<unknown> {
  if (!task.v4SourceApprovalId) return null;
  const decision = await tx.amuxIdeaUnitDecision.findUnique({ where: { id: task.v4SourceApprovalId },
    select: { state: true, action: true, registeredWorkItemId: true, confirmationSnapshot: true } });
  if (decision?.state !== "consumed" || decision.action !== "register_card" ||
      decision.registeredWorkItemId !== task.id) return null;
  const snapshot = decision.confirmationSnapshot as
    { card?: { task?: { costReceipt?: unknown } } } | null;
  return snapshot?.card?.task?.costReceipt ?? null;
}

async function offerFor(tx: Prisma.TransactionClient, task: TaskFacts):
  Promise<{ offer: AmuxV4TaskCeilingReapprovalOffer; confirmedDigest: string | null }> {
  const original = await confirmationReceipt(tx, task);
  const approved = task.executionGrade ?
    await readAmuxV52TaskReceipt(tx, task.id, original, task.executionGrade) : null;
  let current = null;
  if (task.taskRole && task.executionGrade) {
    try {
      current = (await calculateCurrentApprovedAmuxV4TaskCost(tx, task.taskRole,
        task.executionGrade)).receipt;
    } catch (error) {
      // A catalog refusal is a known price hold; any SQL failure aborts the
      // transaction and must reach the caller as unknown.
      if (!(error instanceof AmuxV4TaskCatalogApprovalError)) throw error;
    }
  }
  const offer = amuxV4TaskCeilingReapprovalOffer({
    v4Task: task.sourceSystem === "admin-idea-v4" && task.cardType === "task",
    status: task.status, liveAttempt: task.liveAttempt, activeDelivery: task.activeDelivery,
    role: task.taskRole, grade: task.executionGrade, approved, current });
  const confirmed = original && typeof original === "object" && !Array.isArray(original) &&
    typeof (original as { receiptDigest?: unknown }).receiptDigest === "string" ?
    (original as { receiptDigest: string }).receiptDigest : null;
  return { offer, confirmedDigest: confirmed };
}

function viewOf(offer: AmuxV4TaskCeilingReapprovalOffer): AmuxV4TaskCeilingReapprovalView {
  const approvedIds = new Set(offer.approved?.routes.map((route) => route.routeId) ?? []);
  return {
    eligible: offer.eligible,
    refusal: offer.eligible ? null : offer.refusal,
    reason: offer.eligible ? offer.reason : null,
    approvedCeilingMicroUsd: offer.approved?.ceilingMicroUsd ?? null,
    currentCeilingMicroUsd: offer.current?.ceilingMicroUsd ?? null,
    catalogDigest: offer.current?.catalogDigest ?? null,
    maxAttempts: offer.current?.caps.maxAttempts ?? null,
    routes: (offer.current?.routes ?? []).map((route) => ({ workerName: route.workerName,
      modelId: route.modelId, perAttemptMicroUsd: route.perAttemptMicroUsd,
      approved: approvedIds.has(route.routeId) })),
  };
}

/** The Task detail's read: never writes, never takes a lock. Null on any failure. */
export async function readAmuxV4TaskCeilingReapprovalView(taskId: string):
  Promise<AmuxV4TaskCeilingReapprovalView | null> {
  if (!TASK_ID.test(taskId)) return null;
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT set_config('statement_timeout', '5000', true)`;
    const task = await readTaskFacts(tx, taskId, false);
    if (!task || task.sourceSystem !== "admin-idea-v4" || task.cardType !== "task") return null;
    return viewOf((await offerFor(tx, task)).offer);
  }, { maxWait: 5_000, timeout: 10_000 }).catch(() => null);
}

export type AmuxV4TaskCeilingReapprovalResult =
  | { outcome: "reapproved"; auditId: string; ceilingMicroUsd: string }
  | { outcome: "not_found" }
  | { outcome: "refused"; reason: AmuxV4TaskCeilingReapprovalRefusal | "revision_changed" | "cost_changed" };

/**
 * The audit chain lock first, then the Task row without waiting (a worker's
 * writers lock the card and then the chain), the offer again under the lock,
 * and the owner's binding: the revision, catalog and ceiling they were shown.
 * A price that moved since the owner looked is refused, never approved unseen.
 */
export async function reapproveAmuxV4TaskCeilingForOwner(input: {
  session: Session; request: Request; taskId: string; revision: number;
  catalogDigest: string; ceilingMicroUsd: string;
}): Promise<AmuxV4TaskCeilingReapprovalResult> {
  await assertAmuxLegacyCardOwner(input.session);
  if (!TASK_ID.test(input.taskId)) return { outcome: "not_found" };
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT set_config('statement_timeout', '5000', true),
             set_config('idle_in_transaction_session_timeout', '10000', true)`;
    await takeAuditChainLock(tx);
    const task = await readTaskFacts(tx, input.taskId, true);
    if (!task || task.sourceSystem !== "admin-idea-v4" || task.cardType !== "task")
      return { outcome: "not_found" as const };
    if (task.revision !== input.revision) return { outcome: "refused" as const, reason: "revision_changed" as const };
    const { offer, confirmedDigest } = await offerFor(tx, task);
    if (!offer.eligible) return { outcome: "refused" as const, reason: offer.refusal };
    if (!confirmedDigest) return { outcome: "refused" as const, reason: "approval_invalid" as const };
    if (offer.current.catalogDigest !== input.catalogDigest ||
        offer.current.ceilingMicroUsd !== input.ceilingMicroUsd)
      return { outcome: "refused" as const, reason: "cost_changed" as const };
    const auditId = await writeAdminAuditLog({ tx, session: input.session, request: input.request,
      action: AMUX_V4_TASK_CEILING_REAPPROVED_ACTION, targetType: "AmuxWorkItem", targetId: task.id,
      summary: "Re-approved the cost ceiling of a registered AMUX Task at the current catalog price.",
      metadata: { displayKey: task.displayKey, revision: task.revision, status: task.status,
        role: task.taskRole, grade: task.executionGrade, reconfirmReason: offer.reason,
        confirmedReceiptDigest: confirmedDigest,
        previousReceiptDigest: offer.approved.receiptDigest,
        previousCeilingMicroUsd: offer.approved.ceilingMicroUsd,
        newCeilingMicroUsd: offer.current.ceilingMicroUsd,
        newReceiptDigest: offer.current.receiptDigest,
        newReceipt: offer.current } });
    return { outcome: "reapproved" as const, auditId, ceilingMicroUsd: offer.current.ceilingMicroUsd };
  }, { maxWait: 5_000, timeout: 15_000 }).catch((error: unknown) => {
    if (amuxDatabaseDiagnosticCode(error) === "55P03") throw new AmuxLegacyCardOwnerError("busy");
    throw error;
  });
}
