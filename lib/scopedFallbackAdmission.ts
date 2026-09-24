/**
 * Which candidates a second attempt may name after a failure has a scope.
 *
 * The live fallback policy still chooses the next logical model. This module
 * does not replace it, does not dispatch, and does not read capacity or
 * price. The request path does not import it.
 *
 * An admission is necessary for one more attempt and not sufficient. A live
 * refusal (funding, safety, cancellation) still refuses. The caller dispatches
 * at most `remainingAttempts` names from the list, not every name in it.
 * Abstention admits nobody. A local failure admits nobody. A third dispatched
 * attempt is refused. Absence of an equivalence class neither admits nor
 * refuses a candidate.
 */

import {
    candidateOutsideFailureScope,
    type CanonicalClassification,
    type FailureScopedCandidate,
} from "@/lib/canonicalFailureClassification";

/** Primary dispatch plus one substitution. The same budget the live policy uses. */
export const SCOPED_FALLBACK_ATTEMPT_BUDGET = 2;

export type ScopedFallbackRefusal =
    | "invalid_budget"
    | "budget_spent"
    | "abstained"
    | "local_scope"
    | "same_failure_domain";

export type ScopedFallbackAdmission =
    | { admitted: false; reason: ScopedFallbackRefusal; remainingAttempts: 0 }
    | { admitted: true; remainingAttempts: number; candidates: FailureScopedCandidate[] };

const wholeAttempt = (value: number) => Number.isInteger(value) && value >= 1;

const refused = (reason: ScopedFallbackRefusal): ScopedFallbackAdmission => ({
    admitted: false,
    reason,
    remainingAttempts: 0,
});

/**
 * Candidates that sit outside the failed scope, in the caller's order.
 *
 * `attemptsDispatched` counts attempts already sent, including the one that
 * failed. One sent attempt may name another. Two sent attempts may not name
 * a third. An empty outside set stops; it does not fall through to a
 * candidate that shares the failed scope.
 */
export const admitScopedFallback = (input: {
    failure: CanonicalClassification;
    attemptsDispatched: number;
    candidates: readonly FailureScopedCandidate[];
}): ScopedFallbackAdmission => {
    if (!wholeAttempt(input.attemptsDispatched)) {
        return refused("invalid_budget");
    }
    if (input.attemptsDispatched >= SCOPED_FALLBACK_ATTEMPT_BUDGET) {
        return refused("budget_spent");
    }
    if (input.failure.status !== "classified") {
        return refused("abstained");
    }
    if (input.failure.scopeKind === "local") {
        return refused("local_scope");
    }

    const remainingAttempts = SCOPED_FALLBACK_ATTEMPT_BUDGET - input.attemptsDispatched;
    const admitted: FailureScopedCandidate[] = [];
    for (const candidate of input.candidates) {
        if (candidateOutsideFailureScope(input.failure, candidate).outside) {
            admitted.push(candidate);
        }
    }
    if (admitted.length === 0) {
        return refused("same_failure_domain");
    }
    return { admitted: true, remainingAttempts, candidates: admitted };
};
