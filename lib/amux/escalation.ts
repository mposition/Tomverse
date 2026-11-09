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
  "usage_outcome_unknown",
  // Owner decision 2026-11-06: a failed v22 CLI run whose cause the CLI named.
  "cli_turn_limit",
  "cli_execution_error",
  "cli_budget_limit",
  // Owner decision 2026-11-07: an investigate conclusion parked the Task.
  "analysis_stop",
  "analysis_replan",
  // Owner decision 2026-11-07: the v52 review server rejected a run twice.
  "review_server_rejected_twice",
  "operational_cost_blocked",
  "canonical_deadline_review_required",
  // Policy version 15: why the WSL runner blocked an attempt.
  "local_card_closed",
  "local_card_unlinked",
  "local_card_ambiguous",
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

/** Who resolves an earlier attempt's escalation when a later attempt settles. */
export const AMUX_V22_SETTLEMENT_RESOLVER = "system:amux-v22-settlement";

/**
 * Resolves the execution-recovery escalations an earlier attempt of this Task
 * left open, once a later attempt settles (AMUX-FILEREQ-004, 2026-11-09).
 *
 * Such an escalation asked a person to recover the earlier attempt; the Task
 * has since been run again, so the question is answered. Left open, it kept a
 * done card in the owner queue with no decision to press, and a card going to
 * review or blocked reused its stale reason (openAmuxHumanEscalation returns
 * the open row). "Earlier" is fixed by the Task revision: every settlement and
 * the reaper open their escalation after the revision bump, so a row opened
 * at a revision below the settling attempt's own came before that attempt
 * claimed the Task. Rows that predate the revision column use the clock.
 * Any other specialty (a person's review) is left alone.
 *
 * Callers hold the Task row in their transaction. One system audit entry,
 * only when something was resolved.
 */
export async function resolveSupersededAmuxRecoveryEscalations(
  tx: Prisma.TransactionClient,
  input: {
    taskId: string;
    attemptId: string;
    attemptTaskRevision: number;
    attemptStartedAt: Date;
    now: Date;
  },
) {
  const where = {
    taskId: input.taskId,
    status: { in: ["open", "acknowledged"] },
    specialty: "execution-recovery",
    OR: [
      { openedTaskRevision: { lt: input.attemptTaskRevision } },
      { openedTaskRevision: null, createdAt: { lt: input.attemptStartedAt } },
    ],
  } satisfies Prisma.AmuxHumanEscalationWhereInput;
  const rows = await tx.amuxHumanEscalation.findMany({
    where, select: { id: true }, orderBy: { createdAt: "asc" },
  });
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const resolved = await tx.amuxHumanEscalation.updateMany({
    where: { ...where, id: { in: ids } },
    data: {
      status: "resolved",
      // The CHECK allows approve | retry | block: the later attempt was the retry.
      resolutionOutcome: "retry",
      resolution: `Superseded: a later attempt (${input.attemptId}) of this Task settled.`,
      resolvedById: AMUX_V22_SETTLEMENT_RESOLVER,
      resolvedByEmail: null,
      resolvedAt: input.now,
    },
  });
  if (resolved.count !== ids.length)
    throw new Error("AMUX superseded escalations changed while resolving them");
  await writeSystemAuditLog({
    tx,
    systemActor: "tomverse-amux-orchestrator",
    action: "amux.human_escalation.superseded",
    targetType: "AmuxWorkItem",
    targetId: input.taskId,
    summary: "Resolved an earlier attempt's AMUX recovery escalation after a later attempt settled.",
    metadata: {
      escalation_ids: ids,
      attempt_id: input.attemptId,
      attempt_task_revision: input.attemptTaskRevision,
    },
  });
  return ids;
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
