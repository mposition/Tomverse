import {
  checkV4TaskApprovedCeiling,
  type V4TaskCostCeilingReceipt,
} from "./v4TaskCostCeilingCore.ts";

/**
 * The owner re-approves a registered Task's cost ceiling (owner decision
 * 2026-11-14: "등록된 Task의 상한을 다시 승인").
 *
 * A Task's approved receipt is fixed in its registration confirmation. When
 * the catalog later prices its role and grade above that receipt (a new
 * model route, a higher price, a longer attempt bound), the Task waits on
 * `cost_reconfirmation_required` with no way out but a new registration. The
 * owner now approves the current receipt instead: one audit entry by the
 * administrator writer, naming the confirmation receipt it replaces and the
 * whole new receipt. Readers take the latest such entry over the confirmation
 * (v52GradeReceipt.ts); the confirmation itself never changes.
 */
export const AMUX_V4_TASK_CEILING_REAPPROVED_ACTION = "amux.task.ceiling_reapproved";

/** The Task is waiting: never while an attempt runs or a delivery is out. */
export const AMUX_V4_TASK_CEILING_REAPPROVAL_STATUSES: ReadonlySet<string> =
  new Set(["backlog", "todo", "blocked"]);

export type AmuxV4TaskCeilingReapprovalRefusal =
  | "not_v4_task" | "not_waiting" | "attempt_live" | "approval_invalid"
  | "cost_unavailable" | "role_or_grade_changed" | "within_approved_ceiling";

export type AmuxV4TaskCeilingReapprovalOffer =
  | { eligible: true; approved: V4TaskCostCeilingReceipt; current: V4TaskCostCeilingReceipt;
      reason: string }
  | { eligible: false; refusal: AmuxV4TaskCeilingReapprovalRefusal;
      approved: V4TaskCostCeilingReceipt | null; current: V4TaskCostCeilingReceipt | null };

/**
 * Whether the owner may approve `current` over `approved` (the receipt in
 * force: the confirmation, a grade escalation or an earlier re-approval).
 * Only a receipt the readiness check would not allow is offered, and only on
 * the same role and grade: a changed grade has its own audited path.
 */
export function amuxV4TaskCeilingReapprovalOffer(input: {
  v4Task: boolean; status: string; liveAttempt: boolean; activeDelivery: boolean;
  role: string | null; grade: string | null;
  approved: V4TaskCostCeilingReceipt | null; current: V4TaskCostCeilingReceipt | null;
}): AmuxV4TaskCeilingReapprovalOffer {
  const { approved, current } = input;
  const refuse = (refusal: AmuxV4TaskCeilingReapprovalRefusal) =>
    ({ eligible: false as const, refusal, approved, current });
  if (!input.v4Task || !input.role || !input.grade) return refuse("not_v4_task");
  if (!AMUX_V4_TASK_CEILING_REAPPROVAL_STATUSES.has(input.status)) return refuse("not_waiting");
  if (input.liveAttempt || input.activeDelivery) return refuse("attempt_live");
  if (!approved) return refuse("approval_invalid");
  if (!current) return refuse("cost_unavailable");
  if (approved.role !== input.role || current.role !== input.role ||
      current.grade !== input.grade) return refuse("role_or_grade_changed");
  const check = checkV4TaskApprovedCeiling(approved, { ok: true, receipt: current });
  if (check.decision === "hold") return refuse("approval_invalid");
  if (check.decision === "allow") return refuse("within_approved_ceiling");
  return { eligible: true, approved, current, reason: check.reason };
}

/** A receipt that passes its own digest and ceiling checks, else null. */
export function validV4TaskReceipt(value: unknown): V4TaskCostCeilingReceipt | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as V4TaskCostCeilingReceipt;
  return checkV4TaskApprovedCeiling(candidate, { ok: true,
    receipt: candidate }).decision === "allow" ? candidate : null;
}

export type AmuxV4TaskCeilingReapprovalRow = {
  entryHash: string | null; actorUserId: string | null; metadata: unknown;
};

/**
 * The receipt an owner re-approval put in force, or null when the row is not
 * one: a person's entry (never a system actor), bound to this confirmation
 * receipt and the confirmation's role, carrying a valid whole receipt.
 */
export function readAmuxV4TaskCeilingReapproval(row: AmuxV4TaskCeilingReapprovalRow,
  confirmed: V4TaskCostCeilingReceipt): V4TaskCostCeilingReceipt | null {
  if (!row.entryHash || !row.actorUserId) return null;
  const metadata = row.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const value = metadata as Record<string, unknown>;
  const next = validV4TaskReceipt(value.newReceipt);
  return value.confirmedReceiptDigest === confirmed.receiptDigest &&
    next !== null && next.role === confirmed.role &&
    value.newReceiptDigest === next.receiptDigest ? next : null;
}
