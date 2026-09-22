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
 * endpoint and provider views are derived from it. Idempotent on that id: a
 * projection that failed half way can be run again without double-counting,
 * which is what makes a rollup safe to rebuild rather than something to be
 * careful with.
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
        !(ROUTING_ATTEMPT_ERROR_CLASSES as readonly string[]).includes(input.errorClass)
    ) {
        problems.push(`unknown error class ${JSON.stringify(input.errorClass)}`);
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
 * Whether an event has already been applied to a rollup.
 *
 * The whole idempotency rule in one place: a projection keeps the ids it has
 * seen for a window and applies each at most once. Written as a function so
 * the rule is testable before there is a projection to test.
 */
export const shouldApply = (
    eventId: string,
    alreadyApplied: ReadonlySet<string>
): boolean => Boolean(eventId.trim()) && !alreadyApplied.has(eventId);
