/**
 * What "check what was recorded" tells the operator after a plan approval whose
 * answer was lost (components/admin/AmuxIdeaPlanApprovalPanel.tsx).
 *
 * The approval is all or nothing in one transaction, so a fresh read of the
 * attempt's units decides it. A unit's state in that read is one of the four
 * the analysis result reports (lib/amux/ideaAnalysisResultReadCore.ts) or it
 * is missing from the read:
 *
 * - `approved`: the approval reached the unit. This is the only evidence that
 *   it committed. `rejected` and `expired` are not: an unapproved proposal
 *   expires on its own (the retention sweep marks it `expired`), and a
 *   rejection is the owner's own refusal, so treating "anything but proposed"
 *   as success would announce cards that were never registered;
 * - `proposed`: nothing happened to it;
 * - `rejected`, `expired` or missing: it says nothing about the attempt.
 *
 * Hence:
 * - some unit approved and every unit of the attempt approved: it committed;
 * - some unit approved and some not: not an all-or-nothing state, so never a
 *   reason to approve again;
 * - no unit approved: the approval changed nothing the read can see. Until the
 *   settle window has passed the transaction may still be running; after it,
 *   nothing was recorded, whether the other units are still proposed, expired,
 *   rejected or have dropped out of the read.
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
  /** Every unit of the attempt is approved: it committed. */
  | { kind: "recorded" }
  /** No unit is approved and the settle window has passed: nothing was recorded. */
  | { kind: "not_recorded" }
  /** No unit is approved yet, but the transaction may still be running. */
  | { kind: "settling"; remainingMs: number }
  /** Some units are approved and some are not: never a reason to approve again. */
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
  const approved = own.filter((unit) => unit.decisionState === "approved").length;
  // Every unit of the attempt must be there and approved: a unit that is missing, proposed, rejected or
  // expired beside an approved one is a half-recorded plan, which is never a reason to approve again.
  if (approved > 0) return approved === attempt.unitIds.length ? { kind: "recorded" } : { kind: "mixed" };
  const remainingMs = attempt.startedAt + PLAN_SETTLED_AFTER_MS - now;
  return remainingMs > 0 ? { kind: "settling", remainingMs } : { kind: "not_recorded" };
}

/** Whole seconds to show for a wait: never zero while something is still left. */
export const planReadBackSeconds = (remainingMs: number): number => Math.max(1, Math.ceil(remainingMs / 1000));
