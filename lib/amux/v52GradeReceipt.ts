import type { Prisma } from "@prisma/client";

import {
  checkV4TaskApprovedCeiling,
  type V4TaskCostCeilingReceipt } from "./v4TaskCostCeilingCore.ts";

export const AMUX_GRADE_ESCALATED_ACTION = "amux.grade.escalated";

const receipt = (value: unknown): V4TaskCostCeilingReceipt | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as V4TaskCostCeilingReceipt;
  return checkV4TaskApprovedCeiling(candidate, { ok: true,
    receipt: candidate }).decision === "allow" ? candidate : null;
};

/** The owner-approved receipt stays in the confirmation; a one-time, audited
 * frontier receipt is the only permitted replacement after a path mismatch. */
export async function readAmuxV52TaskReceipt(tx: Prisma.TransactionClient,
  taskId: string, original: unknown, currentGrade: string):
  Promise<V4TaskCostCeilingReceipt | null> {
  const approved = receipt(original);
  if (!approved) return null;
  if (approved.grade === currentGrade) return approved;
  if (currentGrade !== "frontier" || approved.grade === "frontier") return null;
  const rows = await tx.adminAuditLog.findMany({ where: {
    action: AMUX_GRADE_ESCALATED_ACTION,
    targetType: "AmuxWorkItem", targetId: taskId,
  }, select: { entryHash: true, metadata: true }, take: 2 });
  if (rows.length !== 1 || !rows[0]?.entryHash) return null;
  const metadata = rows[0].metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const value = metadata as Record<string, unknown>;
  const escalated = receipt(value.newReceipt);
  return value.reason === "contract_path_touched" &&
    value.originalReceiptDigest === approved.receiptDigest &&
    value.previousGrade === approved.grade && value.nextGrade === "frontier" &&
    escalated?.role === approved.role && escalated.grade === "frontier" ?
    escalated : null;
}
