/**
 * What "check what was recorded" tells the operator after a plan approval whose
 * answer was lost (components/admin/AmuxIdeaPlanApprovalPanel.tsx).
 *
 * The approval is all or nothing in one transaction, so a fresh read of the
 * attempt's units decides it, and each unit of the attempt is one of three
 * things in that read: still proposed (nothing happened to it), decided (the
 * approval reached it), or missing from the read (it cannot say anything).
 * Only the first two carry information:
 *
 * - some unit decided and none still proposed: the approval committed;
 * - some unit decided and some still proposed: not an all-or-nothing state,
 *   so never a reason to approve again;
 * - no unit decided: the approval changed nothing the read can see. Until the
 *   settle window has passed the transaction may still be running; after it,
 *   nothing was recorded, whether the other units are still proposed or have
 *   dropped out of the read.
 *
 * An earlier version counted a missing unit as neither decided nor proposed and
 * waited for "all proposed" or "none proposed", so one unit that left the read
 * kept the panel on "may still be processing" for good, with every remaining
 * unit untouched and the approval locked.
 *
 * Each answer is its own outcome, so the screen can say a different thing for
 * each, and a failed read says the read failed instead of repeating the earlier
 * "unknown". The POST is never sent again from here.
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
  /** The approval reached the units and none is still proposed: it committed. */
  | { kind: "recorded" }
  /** Nothing the read can see changed and the settle window has passed: nothing was recorded. */
  | { kind: "not_recorded" }
  /** Nothing changed yet, but the transaction may still be running. */
  | { kind: "settling"; remainingMs: number }
  /** Some units are decided and some are still proposed: never a reason to approve again. */
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
  const named = new Set(attempt.unitIds);
  const own = input.units.filter((unit) => named.has(unit.id));
  const decided = own.filter((unit) => unit.decisionState !== "proposed").length;
  const proposed = own.length - decided;
  if (decided > 0) return proposed === 0 ? { kind: "recorded" } : { kind: "mixed" };
  const remainingMs = attempt.startedAt + PLAN_SETTLED_AFTER_MS - now;
  return remainingMs > 0 ? { kind: "settling", remainingMs } : { kind: "not_recorded" };
}

/** Whole seconds to show for a wait: never zero while something is still left. */
export const planReadBackSeconds = (remainingMs: number): number => Math.max(1, Math.ceil(remainingMs / 1000));
