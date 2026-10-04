/**
 * When AMUX's view of a run and the engineering agent's view disagree.
 *
 * docs/policy/engineering-agent.md §11 is the contract: neither side is
 * corrected to match the other -- that correction would be an invented fact --
 * so a disagreement becomes a work item a person resolves, and a person's
 * action runs only after both sides are locked and re-read in one
 * transaction, in the order AMUX itself locks them.
 *
 * Pure and dependency-free.
 */

import {
  AMUX_SETTLEMENT_FOR_OUTCOME,
  RUN_OUTCOMES,
  type RunOutcome,
} from "./engineeringAgentCore.ts";

type Settlement = "review" | "retry" | "blocked" | "recovered";

/**
 * The AMUX settlement a domain outcome should have produced. An abandoned run
 * is AMUX's to recover. An outcome this does not know -- a new enum value, an
 * unvalidated string -- maps to nothing, and the caller treats that as
 * unmapped rather than guessing a settlement that would make it look settled.
 */
export const expectedSettlement = (outcome: string): Settlement | null => {
  if (!(RUN_OUTCOMES as readonly string[]).includes(outcome)) return null;
  if (outcome === "abandoned") return "recovered";
  return AMUX_SETTLEMENT_FOR_OUTCOME[outcome as RunOutcome];
};

/* ------------------------------------------------------------------------- */
/* Lock order                                                                 */
/* ------------------------------------------------------------------------- */

/**
 * The one cross-state lock order. The AMUX part is the partial order AMUX's own
 * paths already use (attempt, then work item, then delivery); engineering rows
 * come after every AMUX row because AMUX never locks them. A path may skip a
 * prefix -- a mismatch with no attempt starts at the work item -- but never
 * goes backwards. `AmuxWorkerRuntime` is deliberately absent: the agent's
 * actions never lock it, and a row not locked does not take part in the order.
 */
export const CROSS_LOCK_ORDER = [
  "AmuxExecutionAttempt",
  "AmuxWorkItem",
  "AmuxWorkDelivery",
  "EngineeringAgentRun",
  "EngineeringAgentWorkItem",
  "EngineeringAgentCapability",
  "EngineeringAgentBinding",
] as const;
export type LockedTable = (typeof CROSS_LOCK_ORDER)[number];

/** Whether a sequence of lock acquisitions respects the order. */
export const followsCrossLockOrder = (sequence: readonly LockedTable[]) => {
  let last = -1;
  for (const table of sequence) {
    const index = CROSS_LOCK_ORDER.indexOf(table);
    if (index === -1 || index < last) return false;
    last = index;
  }
  return true;
};

/* ------------------------------------------------------------------------- */
/* Classification                                                             */
/* ------------------------------------------------------------------------- */

export type AmuxAttemptView =
  | { state: "in_progress" }
  | { state: "terminal"; settlement: "review" | "retry" | "blocked" | "recovered" }
  | { state: "absent" };

export type DomainView =
  | { state: "in_progress" }
  | { state: "terminal"; outcome: RunOutcome };

export const MISMATCH_KINDS = ["A", "B", "C", "D"] as const;
export type MismatchKind = (typeof MISMATCH_KINDS)[number];

export type Classification =
  | { kind: "consistent" }
  | { kind: MismatchKind }
  /** A combination the table does not map is itself an incident. */
  | { kind: "unmapped" };

/**
 * The matrix. "Terminal on both sides" compares conclusions: the domain
 * outcome's expected settlement against the settlement AMUX recorded. An
 * abandoned run expects AMUX to recover the attempt.
 */
export const classifyState = (input: {
  amux: AmuxAttemptView;
  domain: DomainView;
  /** The domain side was already terminal at the previous detection round. */
  domainTerminalSinceLastRound: boolean;
}): Classification => {
  const { amux, domain } = input;
  if (amux.state === "in_progress" && domain.state === "in_progress") return { kind: "consistent" };
  if (amux.state === "terminal" && domain.state === "in_progress") return { kind: "A" };
  if (amux.state === "in_progress" && domain.state === "terminal") {
    return input.domainTerminalSinceLastRound ? { kind: "B" } : { kind: "consistent" };
  }
  if (amux.state === "terminal" && domain.state === "terminal") {
    const expected = expectedSettlement(domain.outcome);
    if (expected === null) return { kind: "unmapped" };
    return expected === amux.settlement ? { kind: "consistent" } : { kind: "C" };
  }
  if (amux.state === "absent" && domain.state === "in_progress") return { kind: "D" };
  return { kind: "unmapped" };
};

/* ------------------------------------------------------------------------- */
/* Actions                                                                    */
/* ------------------------------------------------------------------------- */

export const MISMATCH_ACTIONS = [
  "retry_lookup",
  "close_domain_after_verified_no_write",
  "leave_open",
  "mode_off",
  "escalate_incident",
] as const;
export type MismatchAction = (typeof MISMATCH_ACTIONS)[number];

const ALLOWED_ACTIONS: Readonly<Record<MismatchKind, readonly MismatchAction[]>> = {
  A: ["retry_lookup", "close_domain_after_verified_no_write", "leave_open", "mode_off", "escalate_incident"],
  B: ["leave_open", "escalate_incident"],
  C: ["leave_open", "escalate_incident"],
  D: ["retry_lookup", "close_domain_after_verified_no_write", "escalate_incident"],
};

/** Recurrences of the same target and combination before only escalation is left (proposed). */
export const MISMATCH_RECURRENCE_LIMIT = 2;

export type ActionInput = {
  kind: MismatchKind;
  action: MismatchAction;
  /**
   * Under the lock, the AMUX revision, attempt outcome and delivery status equal
   * the values bound at detection. If not, the action does not happen and
   * detection runs again.
   */
  reReadMatchesDetection: boolean;
  /** Preconditions on the domain side. */
  runActive: boolean;
  runTerminal: boolean;
  workItemState: string | null;
  /** The work item is in a terminal state of its kind's table. */
  workItemTerminal: boolean;
  /** A lookup confirmed that nothing was written to GitHub. */
  lookupVerifiedNoWrite: boolean;
  recurrences: number;
};

export type ActionVerdict =
  | { allowed: true; resolves: boolean }
  | { allowed: false; reason: string };

const deny = (reason: string): ActionVerdict => ({ allowed: false, reason });

/**
 * Whether a person's action may run, and whether it closes the item. `leave_open`
 * and `mode_off` never close anything: turning the mode off is an operational
 * act, not a resolution.
 */
export const decideMismatchAction = (input: ActionInput): ActionVerdict => {
  if (!input.reReadMatchesDetection) return deny("state_changed_since_detection");
  if (input.recurrences >= MISMATCH_RECURRENCE_LIMIT && input.action !== "escalate_incident") {
    return deny("recurred_only_escalation_left");
  }
  if (!ALLOWED_ACTIONS[input.kind].includes(input.action)) return deny("action_not_allowed_for_kind");

  switch (input.kind) {
    case "A": {
      const claimedLike =
        input.workItemState === "claimed" || input.workItemState === "needs_lookup";
      if (!input.runActive && !claimedLike) return deny("precondition_not_met");
      break;
    }
    case "B":
    case "C":
      // Both the run and the work item must be terminal: B and C describe
      // disagreements about something already finished.
      if (!input.runTerminal || !input.workItemTerminal) return deny("precondition_not_met");
      break;
    case "D":
      if (!input.runActive && input.workItemState !== "claimed") return deny("precondition_not_met");
      break;
  }

  if (input.action === "close_domain_after_verified_no_write" && !input.lookupVerifiedNoWrite) {
    return deny("no_write_not_verified");
  }
  // Closing the domain side is a normal transition, which resolves A and D; so
  // does escalation. A lookup resolves only through the transition its result
  // leads to, never by itself.
  return {
    allowed: true,
    resolves:
      input.action === "escalate_incident" ||
      input.action === "close_domain_after_verified_no_write",
  };
};

/**
 * How a B item ends once AMUX reaches a terminal state: equal conclusions close
 * it, different ones turn it into C. Nothing closes C except escalation.
 */
export const resolveBOnAmuxTerminal = (input: {
  amuxSettlement: Settlement;
  domainOutcome: string;
}): "resolved" | "C" | "unmapped" => {
  const expected = expectedSettlement(input.domainOutcome);
  if (expected === null) return "unmapped";
  return expected === input.amuxSettlement ? "resolved" : "C";
};
