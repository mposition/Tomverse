/**
 * What "check what was recorded" tells the operator after a plan approval whose
 * answer was lost (components/admin/AmuxIdeaPlanApprovalPanel.tsx).
 *
 * The approval is all or nothing in one transaction, so a fresh read of the
 * attempt's units decides it: none still proposed means it committed; all still
 * proposed long after the transaction could have run means it did not; anything
 * in between waits. Each answer is its own outcome, so the screen can say a
 * different thing for each, and a failed read says the read failed instead of
 * repeating the earlier "unknown". The POST is never sent again from here.
 *
 * Pure: no database, no `server-only`, no clock of its own.
 */

/** Longer than the plan transaction can run (120 s, lib/amux/ideaRequestTimeoutsCore.ts) plus the request around it. */
export const PLAN_SETTLED_AFTER_MS = 180_000;

export type PlanReadBackAttempt = { startedAt: number; unitIds: readonly string[] };
export type PlanReadBackUnit = { id: string; decisionState: string };

export type PlanReadBackOutcome =
  /** The read failed: the outcome is still unknown, and approving again is still refused. */
  | { kind: "read_failed" }
  /** No attempt is remembered (it was settled elsewhere): nothing to say beyond going back to idle. */
  | { kind: "no_attempt" }
  /** None of the attempt's units is still proposed: the approval committed. */
  | { kind: "recorded" }
  /** Every unit is still proposed and the settle window has passed: nothing was recorded. */
  | { kind: "not_recorded" }
  /** Every unit is still proposed but the transaction may still be running. */
  | { kind: "settling"; remainingMs: number }
  /** Only some units are decided: not an all-or-nothing state, so never a reason to approve again. */
  | { kind: "mixed" };

export function decidePlanReadBack(input: {
  attempt: PlanReadBackAttempt | null;
  /** The fresh read of every analysis page, or null when it failed. */
  units: readonly PlanReadBackUnit[] | null;
  now: number;
}): PlanReadBackOutcome {
  if (input.units === null) return { kind: "read_failed" };
  if (input.attempt === null) return { kind: "no_attempt" };
  const { attempt, now } = input;
  const stillProposed = input.units.filter((unit) =>
    attempt.unitIds.includes(unit.id) && unit.decisionState === "proposed").length;
  if (stillProposed === 0) return { kind: "recorded" };
  if (stillProposed < attempt.unitIds.length) return { kind: "mixed" };
  const remainingMs = attempt.startedAt + PLAN_SETTLED_AFTER_MS - now;
  return remainingMs > 0 ? { kind: "settling", remainingMs } : { kind: "not_recorded" };
}

/** Whole seconds to show for a wait: never zero while something is still left. */
export const planReadBackSeconds = (remainingMs: number): number => Math.max(1, Math.ceil(remainingMs / 1000));
