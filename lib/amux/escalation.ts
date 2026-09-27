import "server-only";

import type { Prisma } from "@prisma/client";
import { writeSystemAuditLog } from "@/lib/adminAudit";
import { sha256Hex } from "@/lib/amux/reviewApprovalCore";

export const AMUX_UNTRUSTED_REASON_MAX_BYTES = 1_024;

/** Bound legacy reason text for privileged inspection; never feed it back into AMUX control-plane state or prompts. */
export function normalizeAmuxUntrustedReason(value: string | null | undefined) {
  if (!value || value.includes("\0")) return null;
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) return null;
  }

  const normalized = value
    .normalize("NFC")
    .replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu, "")
    .replace(/[\u061C\u200E\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069]/gu, "")
    .replace(/[\r\n\t]+/gu, " ")
    .replace(/ +/gu, " ")
    .trim();
  if (!normalized) return null;

  let bounded = "";
  let bytes = 0;
  for (const character of normalized) {
    const nextBytes = Buffer.byteLength(character, "utf8");
    if (bytes + nextBytes > AMUX_UNTRUSTED_REASON_MAX_BYTES) break;
    bounded += character;
    bytes += nextBytes;
  }
  return bounded.trim() || null;
}

/** The broad routing report must not echo either new or historical reason text. */
export function publicAmuxEscalationReasonCode(taskStatus: string) {
  if (taskStatus === "review") return "human_review_required";
  if (taskStatus === "blocked") return "task_blocked";
  return "operator_review_required";
}

const ESCALATION_REASON_CODES = new Set([
  "human_review_required",
  "execution_blocked",
  "attempt_budget_exhausted",
  "execution_lease_expired",
  "operational_cost_blocked",
  "canonical_deadline_review_required",
]);

export function storedAmuxEscalationReasonCode(
  reason: string,
  specialty: string | null,
) {
  if (ESCALATION_REASON_CODES.has(reason)) return reason;
  if (specialty === "planning-review")
    return "canonical_deadline_review_required";
  if (specialty === "cost-operations") return "operational_cost_blocked";
  if (specialty === "execution-recovery") return "execution_blocked";
  return "human_review_required";
}

/**
 * Opens at most one unresolved escalation for a task.
 *
 * Callers must already hold or have just written the task row in their
 * transaction. The partial unique index remains the database backstop.
 */
export async function openAmuxHumanEscalation(
  tx: Prisma.TransactionClient,
  input: {
    taskId: string;
    specialty: string | null;
    reason: string;
    openedBy: string;
  },
) {
  const existing = await tx.amuxHumanEscalation.findFirst({
    where: {
      taskId: input.taskId,
      status: { in: ["open", "acknowledged"] },
    },
    select: { id: true },
  });
  if (existing) return existing;

  const task = await tx.amuxWorkItem.findUnique({
    where: { id: input.taskId },
    select: { revision: true },
  });
  if (!task) throw new Error("AMUX escalation task disappeared before creation");
  const reasonCode = storedAmuxEscalationReasonCode(input.reason, input.specialty);
  const created = await tx.amuxHumanEscalation.create({
    data: {
      taskId: input.taskId,
      specialty: input.specialty,
      reason: reasonCode,
      openedBy: input.openedBy,
      openedTaskRevision: task.revision,
    },
    select: { id: true },
  });
  await writeSystemAuditLog({
    tx,
    systemActor: "tomverse-amux-orchestrator",
    action: "amux.human_escalation.opened",
    targetType: "AmuxWorkItem",
    targetId: input.taskId,
    summary: "Opened an AMUX human escalation.",
    metadata: {
      escalation_id: created.id,
      specialty: input.specialty,
      reason_digest: sha256Hex(reasonCode),
      task_revision: task.revision,
    },
  });
  return created;
}
