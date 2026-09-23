/**
 * Counterfactual replay, the named fault list, and config promotion.
 * Counterfactual replay, named faults, and one-step promotion.
 *
 * The objective stays lexicographic. A weighted objective is not an input,
 * and this module does not compute one.
 * Replaying under a policy version this build does not contain is a refusal,
 * not an approximation.
 *
 * The request path does not call this. Nothing here writes a row.
 */

import {
    ROUTER_QUALITY_BANDS,
    ROUTER_SCORE_POLICY_VERSION,
    type RouterQualityBand,
    type RouterTieBreakCriterion,
    type RouterTieBreakSignals,
} from "@/lib/routerScorePolicy";
import {
    rankCandidates,
    type ScoredCandidate,
} from "@/lib/routerSelection";

export const ROUTING_PROMOTION_STATES = [
    "draft",
    "offline_replay",
    "fault_simulation",
    "shadow",
    "small_canary",
    "wider_canary",
    "active",
] as const;

export type RoutingPromotionState = (typeof ROUTING_PROMOTION_STATES)[number];

export const ROUTING_FAULTS = [
    "primary_5xx_spike",
    "latency_2x",
    "latency_5x",
    "credential_429_saturation",
    "byok_credential_expired",
    "region_retention_policy_change",
    "pricing_change",
    "cache_hit_rate_change",
    "quality_gate_stale",
    "quality_gate_fail",
    "malformed_output_spike",
    "model_version_drift",
    "pre_commit_stream_failure",
    "post_commit_stream_failure",
    "all_candidates_saturated",
] as const;

export type RoutingFault = (typeof ROUTING_FAULTS)[number];

export type RoutingFaultEffect =
    | { fault: "primary_5xx_spike"; availability: "server_error" }
    | { fault: "latency_2x" | "latency_5x"; ttftP95Ms: number }
    | { fault: "credential_429_saturation"; capacitySaturated: true }
    | { fault: "byok_credential_expired"; credentialActive: false }
    | { fault: "region_retention_policy_change"; residencyDisclosable: false }
    | { fault: "pricing_change"; costUsable: false }
    | { fault: "cache_hit_rate_change"; cacheSavingsUsable: false }
    | { fault: "quality_gate_stale"; qualityGateStatus: "stale" }
    | { fault: "quality_gate_fail"; qualityGateStatus: "failed" }
    | {
          fault: "malformed_output_spike";
          drift: { signal: "malformed_output_rate"; exceeded: true };
      }
    | { fault: "model_version_drift"; versionDrifted: true }
    | { fault: "pre_commit_stream_failure"; stream: "pre_commit" }
    | { fault: "post_commit_stream_failure"; stream: "post_commit" }
    | { fault: "all_candidates_saturated"; allCandidatesSaturated: true };

export type RoutingReplay = {
    policyVersion: string;
    rankedModelIds: readonly string[];
    decidedBy: RouterTieBreakCriterion | null;
};

const isState = (value: unknown): value is RoutingPromotionState =>
    typeof value === "string" &&
    (ROUTING_PROMOTION_STATES as readonly string[]).includes(value);

const isFault = (value: unknown): value is RoutingFault =>
    typeof value === "string" && (ROUTING_FAULTS as readonly string[]).includes(value);

const finite = (value: unknown): value is number =>
    typeof value === "number" && Number.isFinite(value);

const band = (value: unknown): value is RouterQualityBand =>
    typeof value === "number" &&
    (ROUTER_QUALITY_BANDS as readonly number[]).includes(value);

/**
 * The next promotion state, and only the next one.
 *
 * Draft, offline replay, fault simulation, shadow, small canary, wider
 * canary, active. Skipping, repeating and moving backwards are the same
 * refusal. Active has no successor here. No percentage is chosen.
 */
export const promoteRoutingConfig = (
    from: unknown,
    to: unknown
):
    | { ok: true; from: RoutingPromotionState; to: RoutingPromotionState }
    | { ok: false; reason: "unknown_state" | "not_next" } => {
    if (!isState(from) || !isState(to)) return { ok: false, reason: "unknown_state" };
    const next = ROUTING_PROMOTION_STATES[ROUTING_PROMOTION_STATES.indexOf(from) + 1];
    if (next !== to) return { ok: false, reason: "not_next" };
    return { ok: true, from, to };
};

/**
 * One named fault, with no magnitude the ADR did not already give.
 *
 * A 5xx spike is the server_error class, not a count. Latency scales by 2
 * or by 5, and only a finite non-negative observation. A price change and
 * a cache-rate change do not invent a number: the old cost must not be
 * reused, and there is no cache adjustment to apply. An unknown name is
 * not a fault.
 */
export const applyRoutingFault = (
    fault: unknown,
    input: { ttftP95Ms?: unknown } = {}
): RoutingFaultEffect | null => {
    if (!isFault(fault)) return null;
    if (fault === "latency_2x" || fault === "latency_5x") {
        if (!finite(input.ttftP95Ms) || input.ttftP95Ms < 0) return null;
        const factor = fault === "latency_2x" ? 2 : 5;
        return { fault, ttftP95Ms: input.ttftP95Ms * factor };
    }
    switch (fault) {
        case "primary_5xx_spike":
            return { fault, availability: "server_error" };
        case "credential_429_saturation":
            return { fault, capacitySaturated: true };
        case "byok_credential_expired":
            return { fault, credentialActive: false };
        case "region_retention_policy_change":
            return { fault, residencyDisclosable: false };
        case "pricing_change":
            return { fault, costUsable: false };
        case "cache_hit_rate_change":
            return { fault, cacheSavingsUsable: false };
        case "quality_gate_stale":
            return { fault, qualityGateStatus: "stale" };
        case "quality_gate_fail":
            return { fault, qualityGateStatus: "failed" };
        case "malformed_output_spike":
            return {
                fault,
                drift: { signal: "malformed_output_rate", exceeded: true },
            };
        case "model_version_drift":
            return { fault, versionDrifted: true };
        case "pre_commit_stream_failure":
            return { fault, stream: "pre_commit" };
        case "post_commit_stream_failure":
            return { fault, stream: "post_commit" };
        case "all_candidates_saturated":
            return { fault, allCandidatesSaturated: true };
    }
};

const signalsUsable = (signals: RouterTieBreakSignals | undefined): boolean => {
    if (!signals) return true;
    const costs = signals.expectedTotalCostUsdByModelId;
    if (costs) {
        for (const value of Object.values(costs)) {
            if (!finite(value) || value < 0) return false;
        }
    }
    const rates = signals.recentSuccessRateByModelId;
    if (rates) {
        for (const value of Object.values(rates)) {
            if (!finite(value) || value < 0 || value > 1) return false;
        }
    }
    const latencies = signals.ttftP95MsByModelId;
    if (latencies) {
        for (const value of Object.values(latencies)) {
            if (!finite(value) || value < 0) return false;
        }
    }
    return true;
};

const candidatesUsable = (candidates: readonly ScoredCandidate[]): boolean => {
    const seen = new Set<string>();
    for (const candidate of candidates) {
        if (typeof candidate.modelId !== "string" || candidate.modelId.trim().length === 0) {
            return false;
        }
        if (seen.has(candidate.modelId)) return false;
        seen.add(candidate.modelId);
        const cell = candidate.cell;
        if (!cell || !band(cell.qualityBand)) return false;
        if (cell.qualityCi95Lower !== null && !finite(cell.qualityCi95Lower)) return false;
        if (cell.evidenceRef !== null && typeof cell.evidenceRef !== "string") return false;
    }
    return true;
};

/**
 * Rank the same candidates again under the measurements supplied now.
 *
 * `policyVersion`, when passed, has to be the policy this build ranks
 * with. Another version is a different config, and this function will not
 * invent the ranking it would have produced. `costUsable: false` drops
 * the cost measurements, which is what a pricing fault asks for: the old
 * price is not a stand-in for the new one.
 */
export const replayLexicographicOrder = (input: {
    candidates: readonly ScoredCandidate[];
    signals?: RouterTieBreakSignals;
    policyVersion?: string | null;
    costUsable?: boolean;
}): RoutingReplay | null => {
    if (
        input.policyVersion != null &&
        input.policyVersion !== ROUTER_SCORE_POLICY_VERSION
    ) {
        return null;
    }
    if (!candidatesUsable(input.candidates) || !signalsUsable(input.signals)) return null;
    const signals =
        input.costUsable === false
            ? { ...input.signals, expectedTotalCostUsdByModelId: undefined }
            : input.signals;
    const ranked = rankCandidates(input.candidates, signals ?? {});
    const [first, second] = ranked.ranked;
    return {
        policyVersion: ROUTER_SCORE_POLICY_VERSION,
        rankedModelIds: ranked.ranked.map((candidate) => candidate.modelId),
        decidedBy: first && second ? ranked.decidedBy(first, second) : null,
    };
};
