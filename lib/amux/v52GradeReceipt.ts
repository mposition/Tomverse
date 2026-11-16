import type { Prisma } from "@prisma/client";
import { AMUX_SYSTEM_AUDIT_ACTOR } from "../adminAuditSystemActors.ts";

import {
  AMUX_V4_TASK_CEILING_REAPPROVED_ACTION, readAmuxV4TaskCeilingReapproval,
  validV4TaskReceipt } from "./v4TaskCeilingReapprovalCore.ts";
import type { V4TaskCostCeilingReceipt } from "./v4TaskCostCeilingCore.ts";

export const AMUX_GRADE_ESCALATED_ACTION = "amux.grade.escalated";

const receipt = validV4TaskReceipt;

/** The owner-approved receipt stays in the confirmation. Two audited entries
 * replace it: the owner's latest ceiling re-approval
 * (v4TaskCeilingReapprovalCore.ts), and a one-time frontier receipt after a
 * path mismatch, bound to whichever of the two was in force. */
export async function readAmuxV52TaskReceipt(tx: Prisma.TransactionClient,
  taskId: string, original: unknown, currentGrade: string):
  Promise<V4TaskCostCeilingReceipt | null> {
  const confirmed = receipt(original);
  if (!confirmed) return null;
  const [latest] = await tx.adminAuditLog.findMany({ where: {
    action: AMUX_V4_TASK_CEILING_REAPPROVED_ACTION,
    targetType: "AmuxWorkItem", targetId: taskId,
  }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 1,
  select: { entryHash: true, actorUserId: true, metadata: true } });
  // An entry that does not read holds the Task rather than falling back to
  // an older, lower ceiling the owner already replaced.
  const approved = latest ? readAmuxV4TaskCeilingReapproval(latest, confirmed) : confirmed;
  if (!approved) return null;
  if (approved.grade === currentGrade) return approved;
  if (currentGrade !== "frontier" || approved.grade === "frontier") return null;
  const rows = await tx.adminAuditLog.findMany({ where: {
    action: AMUX_GRADE_ESCALATED_ACTION,
    targetType: "AmuxWorkItem", targetId: taskId,
  }, select: { entryHash: true, actorUserId: true, actorEmail: true,
    ipAddress: true, userAgent: true, metadata: true }, take: 2 });
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
