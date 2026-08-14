/**
 * What happens after an attempt fails: §6 and §7 of the routing policy, as one
 * decision.
 *
 * `RoutingAttempt` was built for this and nothing produced a second attempt.
 * The reason to put the whole rule in one pure function rather than in the
 * chat route's error paths is that the rules do not decompose by call site:
 * whether a failure may be retried depends on the failure *layer*, on whether
 * the user has already seen a token, and on budgets that belong to the logical
 * response rather than to the attempt. Spread across five `catch` blocks, each
 * one would be individually plausible and the set would not be the policy.
 *
 * ## The three outcomes, and why a planner failure is not a fallback
 *
 * - **terminate** -- the request ends. Every refusal is named, because "no
 *   retry happened" and "a retry was refused for this reason" are different
 *   facts and only one of them is diagnosable.
 * - **pass_through** -- the *same* model, one more attempt, with the Planner
 *   skipped. §6 is explicit that a Planner failure is a common-layer failure
 *   and not a model failure: the model did nothing wrong, so switching models
 *   would trade a working model for an unknown one on evidence about neither.
 * - **fallback** -- a *different* model. Only for failures that are evidence
 *   about this model or its provider: an adapter that could not serialise for
 *   it, or a provider that failed before it produced anything.
 *
 * ## Two budgets, both per logical response
 *
 * The pass-through downgrade may be used once per response, "whichever attempt
 * uses it" (§6). So a primary provider failure followed by a Planner failure
 * on the fallback candidate spends it there -- and does not go looking for a
 * third model, which is the case the policy calls out by name.
 *
 * Model fallback is bounded by §6's two-build budget: the primary build and
 * one more. A pass-through does not consume a build, because it reuses the
 * authorized context that was already built.
 */

import type {
  RoutingAttemptOutcome,
  RoutingFailureLayer,
} from "@/lib/routingAttemptStore";

/** Bump when a rule changes, so a recorded decision can be attributed. */
export const FALLBACK_POLICY_VERSION = "routing-fallback-v1";

/**
 * §6's operational setting.
 *
 * `fail_closed` is the default and the shipped posture. §6 ends by saying the
 * switch is enabled only after pass-through evaluation and rollback drills are
 * complete, and neither has happened, so the safe value is the one a
 * deployment gets by doing nothing.
 */
export type PlannerFailureMode = "fail_closed" | "pass_through_once";

export const PLANNER_FAILURE_MODE_FLAG = "ROUTING_PLANNER_FAILURE_MODE";

export const plannerFailureMode = (
  environment: Record<string, string | undefined> = process.env
): PlannerFailureMode =>
  environment[PLANNER_FAILURE_MODE_FLAG] === "pass_through_once"
    ? "pass_through_once"
    : "fail_closed";

/**
 * §6: "the two-build budget". The primary preparation and one more.
 *
 * Expressed as a fallback count rather than a build count because that is what
 * the caller can check before doing the work -- a budget you can only discover
 * you have exceeded is not a budget.
 */
export const MAX_MODEL_FALLBACKS = 1;

export type FallbackRefusal =
  /** The attempt did not fail. */
  | "not_a_failure"
  /** §7: after a visible token the partial response is preserved. */
  | "visible_token_emitted"
  /** §7: cancellation is never an automatic fallback candidate. */
  | "cancelled"
  /** §6: infrastructure and safety-boundary failures fail closed. */
  | "fail_closed_layer"
  /** §6: `plannerFailureMode` is `fail_closed`. */
  | "planner_fail_closed"
  /** §6: the downgrade is available once per logical response. */
  | "pass_through_exhausted"
  /** §6: the two-build budget is spent. */
  | "build_budget_exhausted"
  /** Nothing survived the filters, so there is nothing to fall back to. */
  | "no_candidate";

export type FallbackDecision =
  | { action: "terminate"; reason: FallbackRefusal; version: string }
  | {
      action: "pass_through";
      /** The same model. Saying so explicitly beats inferring it. */
      modelId: string;
      version: string;
    }
  | { action: "fallback"; modelId: string; version: string };

export type FailedAttempt = {
  modelId: string;
  outcome: RoutingAttemptOutcome;
  failureLayer: RoutingFailureLayer;
};

export type RunFallbackState = {
  /** §6: whether the one pass-through downgrade has been spent. */
  passThroughUsed: boolean;
  /** How many times this response has already moved to a different model. */
  rerouteCount: number;
  /**
   * Whether the user has seen any token of this response.
   *
   * Separate from the outcome because the two can disagree in the direction
   * that matters: an attempt can fail at the provider after the stream has
   * begun, and §7 is about what the *user* saw, not about where the error
   * came from.
   */
  visibleTokenEmitted: boolean;
};

export type FallbackInput = {
  attempt: FailedAttempt;
  run: RunFallbackState;
  /**
   * Models the Router would choose next, ranked, already excluding everything
   * attempted. Empty means the filters left nothing.
   *
   * Supplied by the caller rather than computed here so this stays pure and so
   * the fallback candidate goes through the same filters as the primary --
   * §6 requires it, and a policy module that picked a model itself would be
   * choosing one that had passed nothing.
   */
  nextCandidateModelIds: readonly string[];
  plannerMode?: PlannerFailureMode;
};

/**
 * What to do after `attempt` failed.
 *
 * The order of the checks is the policy's own order of precedence, and it
 * matters most where two rules would both apply: a Planner failure on a
 * response whose first token has already been shown is refused for the visible
 * token, not offered a pass-through, because §7's rule about partial responses
 * is about what the user is looking at and outranks anything about layers.
 */
export const decideFallback = (input: FallbackInput): FallbackDecision => {
  const version = FALLBACK_POLICY_VERSION;
  const { attempt, run } = input;

  if (attempt.outcome === "succeeded") {
    return { action: "terminate", reason: "not_a_failure", version };
  }

  // §7, first and unconditionally. After a visible token the partial response
  // is preserved and the user gets explicit retry controls instead; silently
  // restarting on another model would replace text they are already reading.
  if (run.visibleTokenEmitted || attempt.outcome === "failed_post_token") {
    return { action: "terminate", reason: "visible_token_emitted", version };
  }

  // §7 names cancellation as not a fallback candidate. It is also the case
  // where retrying is most obviously wrong: the user asked for it to stop.
  if (attempt.outcome === "cancelled") {
    return { action: "terminate", reason: "cancelled", version };
  }

  // §6: manifest, authorization and billing-preparation failures are
  // infrastructure or safety-boundary failures. Retrying one on another model
  // would be retrying the boundary that just refused, which is how a
  // safety check becomes a rate limit.
  if (attempt.failureLayer === "manifest" || attempt.failureLayer === "billing") {
    return { action: "terminate", reason: "fail_closed_layer", version };
  }

  if (attempt.failureLayer === "planner") {
    const mode = input.plannerMode ?? plannerFailureMode();
    if (mode === "fail_closed") {
      return { action: "terminate", reason: "planner_fail_closed", version };
    }
    if (run.passThroughUsed) {
      return { action: "terminate", reason: "pass_through_exhausted", version };
    }
    // The same model, deliberately. §6: a Planner failure is a common-layer
    // failure, so the model has done nothing to be replaced for.
    return { action: "pass_through", modelId: attempt.modelId, version };
  }

  // What is left is evidence about this model or its provider: an adapter that
  // could not serialise for it, or a provider that failed before producing
  // anything.
  if (attempt.failureLayer !== "adapter" && attempt.failureLayer !== "provider") {
    return { action: "terminate", reason: "fail_closed_layer", version };
  }

  if (run.rerouteCount >= MAX_MODEL_FALLBACKS) {
    return { action: "terminate", reason: "build_budget_exhausted", version };
  }
  const next = input.nextCandidateModelIds[0];
  if (!next) {
    return { action: "terminate", reason: "no_candidate", version };
  }
  return { action: "fallback", modelId: next, version };
};

/** §5's `fallbackState`, from what the run has done. */
export const fallbackStateFor = (
  decision: FallbackDecision,
  run: RunFallbackState
): "none" | "fallback_used" | "exhausted" => {
  if (decision.action === "fallback") return "fallback_used";
  if (decision.action === "pass_through") {
    return run.rerouteCount > 0 ? "fallback_used" : "none";
  }
  // A refusal that spent a budget is exhausted; one that never had a budget to
  // spend is not. The distinction is what makes "how often does the budget run
  // out" answerable separately from "how often is fallback refused".
  return decision.reason === "build_budget_exhausted" ||
    decision.reason === "pass_through_exhausted"
    ? "exhausted"
    : run.rerouteCount > 0
      ? "fallback_used"
      : "none";
};

/**
 * §8: what a successful automatic fallback leaves behind for the next turn.
 *
 * The sticky model becomes the one that worked, and the one that failed is
 * kept as `recoveryCandidateModelId` -- not discarded. The distinction is the
 * point of the section: a hard fallback is a temporary reaction to a provider
 * being unhealthy, and without a record of what was displaced the conversation
 * would stay on the substitute forever because stickiness would defend it.
 *
 * `null` when the run never fell back, so a normal turn cannot be mistaken for
 * a recovery-pending one.
 */
export type FallbackRecovery = {
  stickyModelId: string;
  switchReason: "temporary_hard_fallback";
  recoveryCandidateModelId: string;
  /** Why the original model was displaced, for the confirm-healthy check. */
  healthEvidence: string;
};

export const recoveryAfterFallback = (input: {
  succeededModelId: string;
  displacedModelId: string | null;
  failureLayer: RoutingFailureLayer;
}): FallbackRecovery | null => {
  if (!input.displacedModelId || input.displacedModelId === input.succeededModelId) {
    return null;
  }
  return {
    stickyModelId: input.succeededModelId,
    switchReason: "temporary_hard_fallback",
    recoveryCandidateModelId: input.displacedModelId,
    healthEvidence: input.failureLayer,
  };
};

/**
 * §8: whether the displaced model may be restored on the next turn, without
 * satisfying the soft-switch hysteresis.
 *
 * Both conditions, not either: the original hard-failure condition confirmed
 * healthy *and* every current filter passing. A restoration on health alone
 * would put the conversation back on a model that has since been retired,
 * repriced out of the plan, or outgrown by the conversation's own length.
 *
 * The rule is deliberately narrow -- §8 grants it to `temporary_hard_fallback`
 * and to nothing else. A model the user was moved off for any other reason
 * gets the ordinary hysteresis, because the ordinary reason to move is not
 * expected to reverse itself.
 */
export const mayRestoreRecoveryCandidate = (input: {
  switchReason: string | null;
  recoveryCandidateModelId: string | null;
  candidateIsHealthy: boolean;
  candidatePassesFilters: boolean;
}): boolean =>
  input.switchReason === "temporary_hard_fallback" &&
  Boolean(input.recoveryCandidateModelId) &&
  input.candidateIsHealthy &&
  input.candidatePassesFilters;
