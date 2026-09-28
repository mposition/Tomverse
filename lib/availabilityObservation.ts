/**
 * One availability observation, and the rollups derived from it.
 *
 * Dark. Nothing writes observations yet.
 *
 * ## One record, three summaries
 *
 * The routing work needs availability per deployment, and the samples that
 * exist are per provider: real traffic increments `ProviderHealthState`, and
 * the scheduler inserts a `ProviderProbeResult` per provider for one
 * representative model. The two share no identifier, so the same outage is two
 * facts nothing can join.
 *
 * So an observation is written once, carries an `eventId`, and the deployment,
 * endpoint and provider views are derived from it. The id is the key a
 * projection would be idempotent on; a unique index stops the same observation
 * being inserted twice, and that is all it stops. `shouldApply` is that
 * insert check. It is not grain application: one event still rolls up to
 * provider, endpoint, and deployment separately, and that record is
 * `AvailabilityRollupApplication`.
 *
 * ## Nothing is backfilled
 *
 * A past observation had no deployment, and giving it one would be an
 * attribution nobody made. `provider` is always knowable; the other two are
 * null until deployments route.
 *
 * Pure: no database, no clock, no network.
 */

import { ROUTING_ATTEMPT_ERROR_CLASSES } from "@/lib/routingAttemptStore";

/**
 * Where an observation came from.
 *
 * Three streams, kept apart for the reason `ProviderHealthState` already keeps
 * them apart in separate columns: an operator proving the API answers is not
 * the same claim as "real user traffic is being served", and a synthetic probe
 * is neither. Folding them would let a passing probe cover for traffic that is
 * failing.
 */
export const AVAILABILITY_OBSERVATION_SOURCES = [
    "real_traffic",
    "synthetic_probe",
    "operator_verification",
] as const;

export type AvailabilityObservationSource =
    (typeof AVAILABILITY_OBSERVATION_SOURCES)[number];

export const AVAILABILITY_OBSERVATION_OUTCOMES = ["succeeded", "failed"] as const;

export type AvailabilityObservationOutcome =
    (typeof AVAILABILITY_OBSERVATION_OUTCOMES)[number];

/**
 * The failures that mean the provider could not serve the request.
 *
 * A subset of `ROUTING_ATTEMPT_ERROR_CLASSES`, and the spelling is shared on
 * purpose -- an attempt and an observation calling a rate limit different
 * things is how the two grains of health stopped being joinable. What is not
 * shared is which of them counts as unavailable here.
 *
 * The first draft admitted the whole vocabulary, which would have put every
 * one of these into an availability rollup:
 *
 * - `provider_rate_limited` -- capacity, and the reason `QuotaCapacityState`
 *   exists. Counting it as unavailable here would undo that table in the
 *   summary it feeds;
 * - `empty_response`, `provider_model_transient` -- the call succeeded and the
 *   answer was unusable, which `failureLayer: "model_output"` keeps out of
 *   provider health for exactly this reason;
 * - `client_gone` -- the person left;
 * - `process_stopped_after_dispatch`, `completion_handling_failed`,
 *   `request_failed` -- ours;
 * - `provider_policy_refusal`, `provider_payment_required`,
 *   `provider_authentication`, `provider_request_contract`,
 *   `provider_model_not_found`, `provider_local_rejection` -- the provider
 *   answered, and the answer was about this request or this account rather
 *   than about whether it could serve.
 *
 * `RoutingAttempt` draws these lines with `failureLayer`. An observation has
 * no layer, so the line is drawn by which classes may appear at all.
 */
export const AVAILABILITY_FAILURE_CLASSES = [
    /** The provider answered with an error of its own. */
    "provider_server_error",
    /** The request never completed a round trip. */
    "provider_network",
    /** A provider failure nothing could classify further. */
    "provider_unknown",
    /** No first token inside the turn's deadline. */
    "first_token_deadline_exceeded",
] as const;

export type AvailabilityFailureClass =
    (typeof AVAILABILITY_FAILURE_CLASSES)[number];

/** The grains a rollup can be taken at, widest last. */
export const AVAILABILITY_ROLLUP_GRAINS = [
    "deployment",
    "endpoint",
    "provider",
] as const;

export type AvailabilityRollupGrain =
    (typeof AVAILABILITY_ROLLUP_GRAINS)[number];

export type AvailabilityObservationInput = {
    eventId: string;
    source: string;
    outcome: string;
    provider: string;
    providerEndpointId?: string | null;
    modelDeploymentId?: string | null;
    errorClass?: string | null;
    latencyMs?: number | null;
};

/**
 * Why an observation is not well formed, or an empty list.
 *
 * The database holds the same rules. Here so a caller can say which part is
 * wrong rather than only that the write failed.
 */
export const availabilityObservationProblems = (
    input: AvailabilityObservationInput
): readonly string[] => {
    const problems: string[] = [];

    if (!input.eventId.trim()) {
        problems.push("an observation carries the id a projection is idempotent on");
    }
    if (!(AVAILABILITY_OBSERVATION_SOURCES as readonly string[]).includes(input.source)) {
        problems.push(`unknown source ${JSON.stringify(input.source)}`);
    }
    if (!(AVAILABILITY_OBSERVATION_OUTCOMES as readonly string[]).includes(input.outcome)) {
        problems.push(`unknown outcome ${JSON.stringify(input.outcome)}`);
        return problems;
    }
    if (!input.provider.trim()) {
        problems.push("every observation knows its provider");
    }

    // A success has nothing to classify, and a failure that classifies nothing
    // is the record this whole line of work exists to stop being written.
    if (input.outcome === "failed" && !input.errorClass) {
        problems.push("a failure says what kind it was");
    }
    if (input.outcome === "succeeded" && input.errorClass) {
        problems.push("a success has no error class");
    }
    if (
        input.errorClass &&
        !(AVAILABILITY_FAILURE_CLASSES as readonly string[]).includes(input.errorClass)
    ) {
        // Either it is not a class at all, or it is one that means something
        // other than "the provider could not serve this". Both are refused;
        // the second earns its own sentence, because a rate limit recorded as
        // unavailable undoes the capacity table in the summary it feeds.
        const known = (ROUTING_ATTEMPT_ERROR_CLASSES as readonly string[]).includes(
            input.errorClass
        );
        problems.push(
            known
                ? `${JSON.stringify(input.errorClass)} is not an availability failure`
                : `unknown error class ${JSON.stringify(input.errorClass)}`
        );
    }

    // An endpoint is what a deployment is served from. An observation naming a
    // deployment and no endpoint would sit in the deployment view and vanish
    // from the endpoint view, which reads as an endpoint that had no trouble.
    if (input.modelDeploymentId && !input.providerEndpointId) {
        problems.push("a deployment observation names the endpoint it ran on");
    }

    if (typeof input.latencyMs === "number" && input.latencyMs < 0) {
        problems.push("a latency is not negative");
    }

    return problems;
};

/**
 * The grains this observation can be rolled up to.
 *
 * Always the provider; the narrower two only when the observation carries
 * them. A projection reads this rather than guessing, so an observation from
 * before deployments existed contributes to the provider view and to nothing
 * it was never part of.
 */
export const rollupGrainsFor = (
    input: Pick<AvailabilityObservationInput, "providerEndpointId" | "modelDeploymentId">
): readonly AvailabilityRollupGrain[] => {
    const grains: AvailabilityRollupGrain[] = ["provider"];
    if (input.providerEndpointId) grains.unshift("endpoint");
    if (input.providerEndpointId && input.modelDeploymentId) grains.unshift("deployment");
    return grains;
};

/**
 * Whether this observation event id was already recorded.
 *
 * This is the insert check only. It does not record which grain was
 * applied, and a caller must not treat one hit here as every rollup of
 * that event. Grain application lives in the rollup module.
 */
export const shouldApply = (
    eventId: string,
    alreadyApplied: ReadonlySet<string>
): boolean =>
    eventId.length > 0 && eventId === eventId.trim() && !alreadyApplied.has(eventId);
