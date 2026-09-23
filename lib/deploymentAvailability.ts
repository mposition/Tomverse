/**
 * Deployment availability, ADR v2.1 §7.2 and §7.3.
 *
 * Capacity is not this. A 429 and a malformed output do not move the
 * breaker and do not enter the failure risk. Quality drift is a separate
 * series.
 *
 * The prior in the ADR's shrinkage example is not applied. When the eligible
 * attempt count is below 1, or the counts are not usable, the risk abstains.
 * Inventing a prior would answer with a number nobody measured.
 *
 * How many availability failures open the breaker is not decided here. The
 * caller passes `trip`. This function only applies the state grammar.
 *
 * Pure. Nothing reads a deployment row, and nothing here is on the request
 * path yet.
 */

export const AVAILABILITY_FAILURE_KINDS = [
    "server_error",
    "connection_error",
    "pre_commit_timeout",
    "transport_corruption",
] as const;

export type AvailabilityFailureKind = (typeof AVAILABILITY_FAILURE_KINDS)[number];

/** Observations that must not be filed as availability. */
export const NON_AVAILABILITY_KINDS = ["rate_limited", "malformed_output"] as const;

export type NonAvailabilityKind = (typeof NON_AVAILABILITY_KINDS)[number];

export const BREAKER_STATES = ["closed", "open", "half_open"] as const;

export type BreakerState = (typeof BREAKER_STATES)[number];

const isFailureKind = (kind: string): kind is AvailabilityFailureKind =>
    (AVAILABILITY_FAILURE_KINDS as readonly string[]).includes(kind);

const isNonAvailabilityKind = (kind: string): kind is NonAvailabilityKind =>
    (NON_AVAILABILITY_KINDS as readonly string[]).includes(kind);

/**
 * Whether this observation belongs in the availability numerator.
 *
 * Unknown kinds are not availability and not the excluded pair. The caller
 * cannot treat them as a success or as a 5xx.
 */
export const availabilityObservationClass = (
    kind: string
): "availability" | "excluded" | "unknown" => {
    if (isFailureKind(kind)) return "availability";
    if (isNonAvailabilityKind(kind)) return "excluded";
    return "unknown";
};

const whole = (value: number): boolean => Number.isInteger(value) && value >= 0;

/**
 * Raw availability failure risk, without a prior.
 *
 * `(1.0 * n5xx + 1.2 * nTimeout + 1.0 * nConnection) / nEligible` when
 * `nEligible` is at least 1 and every count is a non-negative integer.
 * Otherwise `insufficient`. Transport corruption is not in this ratio; the
 * ADR's formula names the three counts and no fourth.
 */
export const rawAvailabilityFailureRisk = (input: {
    n5xx: number;
    nTimeout: number;
    nConnection: number;
    nEligible: number;
}): { evidence: "insufficient" } | { evidence: "measured"; risk: number } => {
    if (
        !whole(input.n5xx) ||
        !whole(input.nTimeout) ||
        !whole(input.nConnection) ||
        !whole(input.nEligible)
    ) {
        return { evidence: "insufficient" };
    }
    if (input.nEligible < 1) return { evidence: "insufficient" };
    // The 1.2 weight can push the ratio above 1. A count of failures that
    // already exceeds the attempts cannot, and is not a measurement.
    if (input.n5xx + input.nTimeout + input.nConnection > input.nEligible) {
        return { evidence: "insufficient" };
    }
    const numerator = input.n5xx + 1.2 * input.nTimeout + input.nConnection;
    return { evidence: "measured", risk: numerator / input.nEligible };
};

const isState = (state: string): state is BreakerState =>
    (BREAKER_STATES as readonly string[]).includes(state);

/**
 * The next breaker state.
 *
 * `ignored` is a 429 or a malformed output: the state does not move.
 * `trip` is the caller's decision that this availability failure opens a
 * closed breaker. This module does not choose that count.
 * An open breaker stays open until the caller admits a probe. A half-open
 * success closes. A half-open availability failure opens. An unknown state
 * or event is null, which is not `closed`.
 */
export const nextAvailabilityBreaker = (input: {
    state: string;
    event: string;
    trip?: boolean;
}): BreakerState | null => {
    if (!isState(input.state)) return null;
    if (input.event === "ignored") return input.state;
    if (input.event === "admit_probe") {
        return input.state === "open" ? "half_open" : input.state;
    }
    if (input.event === "success") {
        return input.state === "half_open" ? "closed" : input.state;
    }
    if (input.event === "availability_failure") {
        if (input.state === "half_open") return "open";
        if (input.state === "closed" && input.trip === true) return "open";
        return input.state;
    }
    return null;
};
