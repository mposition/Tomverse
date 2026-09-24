/**
 * Admission for a synthetic canary observation.
 *
 * Unproven residency is not a routing candidate, and user traffic is not
 * a way to prove it. The caller supplies the facts. This module does not
 * choose a sample size, does not call a provider, and does not select a
 * model. The request path does not import it. The live probe selector is
 * unchanged.
 */

export type CanaryLaneFacts = {
    synthetic: boolean;
    userContentPresent: boolean;
    residencyProven: boolean;
    separateCredentialQuota: boolean;
    separateProviderBudget: boolean;
    normalRoutingCandidate: boolean;
    observationWindowPassed: boolean | null;
};

export type CanaryLaneRefusal =
    | "user_content"
    | "not_synthetic"
    | "residency_unproven"
    | "shared_credential_quota"
    | "shared_provider_budget"
    | "routing_candidate"
    | "observation_window_unproven";

export type CanaryLaneDecision =
    | { admitted: false; reason: CanaryLaneRefusal }
    | { admitted: true; routingCandidate: false };

export const admitCanaryLane = (facts: CanaryLaneFacts): CanaryLaneDecision => {
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
    if (facts.observationWindowPassed !== true) {
        return { admitted: false, reason: "observation_window_unproven" };
    }
    return { admitted: true, routingCandidate: false };
};
