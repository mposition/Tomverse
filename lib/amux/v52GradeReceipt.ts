import type { Prisma } from "@prisma/client";
import { AMUX_SYSTEM_AUDIT_ACTOR } from "../adminAuditSystemActors.ts";

import {
  AMUX_V4_TASK_CEILING_REAPPROVED_ACTION, readAmuxV4TaskCeilingReapproval,
  validV4TaskReceipt } from "./v4TaskCeilingReapprovalCore.ts";
import type { V4TaskCostCeilingReceipt } from "./v4TaskCostCeilingCore.ts";
import { readAmuxV4ApprovedCeiling } from "./v22TaskFeedbackCore.ts";

export const AMUX_GRADE_ESCALATED_ACTION = "amux.grade.escalated";

const receipt = validV4TaskReceipt;

export type AmuxV52ReapprovalRow = {
  entryHash: string | null; actorUserId: string | null; metadata: unknown;
};
export type AmuxV52EscalationRow = AmuxV52ReapprovalRow & {
  actorEmail: string | null; ipAddress: string | null; userAgent: string | null;
};

export const AMUX_V52_REAPPROVAL_SELECT = {
  entryHash: true, actorUserId: true, metadata: true } as const;
export const AMUX_V52_ESCALATION_SELECT = { entryHash: true, actorUserId: true,
  actorEmail: true, ipAddress: true, userAgent: true, metadata: true } as const;

/** The owner-approved receipt stays in the confirmation. Two audited entries
 * replace it: the owner's latest ceiling re-approval
 * (v4TaskCeilingReapprovalCore.ts), and a one-time frontier receipt after a
 * path mismatch, bound to whichever of the two was in force. Pure, so the
 * Admin feedback reads the ceiling in force by the same rule as execution. */
export function resolveAmuxV52TaskReceipt(input: {
  original: unknown; currentGrade: string | null;
  /** The newest re-approval entry for the Task, or null when there is none. */
  latestReapproval: AmuxV52ReapprovalRow | null;
  /** The Task's grade escalation entries (two are enough to refuse). */
  escalations: readonly AmuxV52EscalationRow[];
}): V4TaskCostCeilingReceipt | null {
  const confirmed = receipt(input.original);
  if (!confirmed) return null;
  // An entry that does not read holds the Task rather than falling back to
  // an older, lower ceiling the owner already replaced.
  const approved = input.latestReapproval ?
    readAmuxV4TaskCeilingReapproval(input.latestReapproval, confirmed) : confirmed;
  if (!approved) return null;
  if (approved.grade === input.currentGrade) return approved;
  if (input.currentGrade !== "frontier" || approved.grade === "frontier") return null;
  const rows = input.escalations;
  if (rows.length !== 1 || !rows[0]?.entryHash ||
      rows[0].actorUserId !== null || rows[0].actorEmail !== null ||
      rows[0].ipAddress !== null || rows[0].userAgent !== null) return null;
  const metadata = rows[0].metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const value = metadata as Record<string, unknown>;
  const escalated = receipt(value.newReceipt);
  return value.systemActor === AMUX_SYSTEM_AUDIT_ACTOR &&
    value.classificationFailure === true &&
    value.reason === "contract_path_touched" &&
    value.originalReceiptDigest === approved.receiptDigest &&
    value.previousGrade === approved.grade && value.nextGrade === "frontier" &&
    escalated?.role === approved.role && escalated.grade === "frontier" ?
    escalated : null;
}

export async function readAmuxV52TaskReceipt(tx: Prisma.TransactionClient,
  taskId: string, original: unknown, currentGrade: string):
  Promise<V4TaskCostCeilingReceipt | null> {
  if (!receipt(original)) return null;
  const [latest] = await tx.adminAuditLog.findMany({ where: {
    action: AMUX_V4_TASK_CEILING_REAPPROVED_ACTION,
    targetType: "AmuxWorkItem", targetId: taskId,
  }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 1,
  select: AMUX_V52_REAPPROVAL_SELECT });
  const escalations = currentGrade === "frontier" ? await tx.adminAuditLog.findMany({ where: {
    action: AMUX_GRADE_ESCALATED_ACTION,
    targetType: "AmuxWorkItem", targetId: taskId,
  }, select: AMUX_V52_ESCALATION_SELECT, take: 2 }) : [];
  return resolveAmuxV52TaskReceipt({ original, currentGrade,
    latestReapproval: latest ?? null, escalations });
}

/** The registration receipt inside a confirmation snapshot, or undefined. */
function confirmationReceipt(snapshot: unknown): unknown {
  const card = snapshot && typeof snapshot === "object" ?
    (snapshot as { card?: unknown }).card : undefined;
  const task = card && typeof card === "object" ? (card as { task?: unknown }).task : undefined;
  return task && typeof task === "object" ?
    (task as { costReceipt?: unknown }).costReceipt : undefined;
}

/**
 * The approved ceiling the Admin feedback shows for one Task. A Task with no
 * re-approval and no escalation entry reads as it always did
 * (readAmuxV4ApprovedCeiling); otherwise the receipt in force decides, and a
 * receipt that does not resolve leaves the ceiling unknown rather than the
 * lower amount it replaced.
 */
export function amuxV52ApprovedCeilingInForce(input: {
  confirmationSnapshot: unknown; currentGrade: string | null;
  latestReapproval: AmuxV52ReapprovalRow | null;
  escalations: readonly AmuxV52EscalationRow[];
}): bigint | null {
  if (!input.latestReapproval && input.escalations.length === 0)
    return readAmuxV4ApprovedCeiling(input.confirmationSnapshot);
  const inForce = resolveAmuxV52TaskReceipt({
    original: confirmationReceipt(input.confirmationSnapshot),
    currentGrade: input.currentGrade, latestReapproval: input.latestReapproval,
    escalations: input.escalations });
  return inForce ? BigInt(inForce.ceilingMicroUsd) : null;
}
