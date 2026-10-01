/**
 * Two decisions for a synthetic canary, kept apart.
 *
 * Collecting a synthetic observation does not require the observation
 * window to have passed already. That window is how the samples are
 * gathered. Routing eligibility is the later decision, and it stays
 * closed until the window has passed. Neither decision calls a provider
 * or selects a model. The request path does not import this module.
 * The live probe selector is unchanged.
 */

export type CanaryObservationFacts = {
    synthetic: boolean;
    userContentPresent: boolean;
    residencyProven: boolean;
    separateCredentialQuota: boolean;
    separateProviderBudget: boolean;
    normalRoutingCandidate: boolean;
};

export type CanaryObservationRefusal =
    | "user_content"
    | "not_synthetic"
    | "residency_unproven"
    | "shared_credential_quota"
    | "shared_provider_budget"
    | "routing_candidate";

export type CanaryObservationDecision =
    | { admitted: false; reason: CanaryObservationRefusal }
    | { admitted: true; routingCandidate: false };

export const admitCanaryObservation = (
    facts: CanaryObservationFacts
): CanaryObservationDecision => {
    if (facts.userContentPresent) return { admitted: false, reason: "user_content" };
    if (!facts.synthetic) return { admitted: false, reason: "not_synthetic" };
    if (!facts.residencyProven) return { admitted: false, reason: "residency_unproven" };
    if (!facts.separateCredentialQuota) {
        return { admitted: false, reason: "shared_credential_quota" };
    }
    if (!facts.separateProviderBudget) {
        return { admitted: false, reason: "shared_provider_budget" };
    }
    if (facts.normalRoutingCandidate) return { admitted: false, reason: "routing_candidate" };
    return { admitted: true, routingCandidate: false };
};

export type CanaryRoutingFacts = {
    observationAdmitted: boolean;
    observationWindowPassed: boolean | null;
};

export type CanaryRoutingDecision =
    | { routingEligible: false; reason: "observation_not_admitted" | "observation_window_unproven" }
    | { routingEligible: true };

/**
 * Whether unproven bootstrap may lift.
 *
 * An admitted observation is not yet routing-eligible. A missing window
 * is not a passed window. This does not dispatch traffic.
 */
export const canaryRoutingEligibility = (facts: CanaryRoutingFacts): CanaryRoutingDecision => {
    if (!facts.observationAdmitted) {
        return { routingEligible: false, reason: "observation_not_admitted" };
    }
    if (facts.observationWindowPassed !== true) {
        return { routingEligible: false, reason: "observation_window_unproven" };
    }
    return { routingEligible: true };
};
