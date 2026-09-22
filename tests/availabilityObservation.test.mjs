import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
    AVAILABILITY_FAILURE_CLASSES,
    AVAILABILITY_OBSERVATION_SOURCES,
    availabilityObservationProblems,
    rollupGrainsFor,
    shouldApply,
} from "../lib/availabilityObservation.ts";
import { ROUTING_ATTEMPT_ERROR_CLASSES } from "../lib/routingAttemptStore.ts";

/**
 * One availability observation, and the rollups derived from it.
 *
 * What these hold is what the table actually gives: one observation cannot be
 * inserted twice, an availability failure is only a failure of availability,
 * and nothing is attributed to a grain it was never part of.
 *
 * A re-runnable projection is a further thing and is not here -- no rollup
 * table records what it has applied, so `shouldApply` is the rule stated
 * ahead of the thing that will follow it.
 */

const migration = () =>
    readFileSync(
        new URL(
            "../prisma/migrations/20260923200000_availability_observation_dark/migration.sql",
            import.meta.url
        ),
        "utf8"
    );

const ok = (overrides = {}) => ({
    eventId: "evt_1",
    source: "real_traffic",
    outcome: "succeeded",
    provider: "openai",
    ...overrides,
});

test("a well formed observation is accepted", () => {
    assert.deepEqual(availabilityObservationProblems(ok()), []);
    assert.deepEqual(
        availabilityObservationProblems(
            ok({ outcome: "failed", errorClass: "provider_server_error" })
        ),
        []
    );
});

test("a failure says what kind it was", () => {
    // A failure that classifies nothing is the record this whole line of work
    // exists to stop being written.
    assert.deepEqual(availabilityObservationProblems(ok({ outcome: "failed" })), [
        "a failure says what kind it was",
    ]);
    assert.deepEqual(
        availabilityObservationProblems(ok({ errorClass: "provider_network" })),
        ["a success has no error class"]
    );
});

test("the spelling is shared and the membership is not", () => {
    // Sharing the spelling keeps an attempt and an observation from calling a
    // rate limit different things. Sharing the membership would have counted
    // one as the provider being unavailable.
    for (const errorClass of AVAILABILITY_FAILURE_CLASSES) {
        assert.ok(
            ROUTING_ATTEMPT_ERROR_CLASSES.includes(errorClass),
            `${errorClass} is spelled the same in both`
        );
        assert.deepEqual(
            availabilityObservationProblems(ok({ outcome: "failed", errorClass })),
            [],
            errorClass
        );
    }
    assert.deepEqual(
        availabilityObservationProblems(ok({ outcome: "failed", errorClass: "went_wrong" })),
        ['unknown error class "went_wrong"']
    );
});

test("what is not an availability failure is refused, and says which", () => {
    // Each of these is a real class and none means the provider could not
    // serve the request. The rate limit is the sharpest: counting it here
    // would undo the capacity table in the summary this feeds.
    for (const errorClass of [
        "provider_rate_limited",
        "empty_response",
        "provider_model_transient",
        "client_gone",
        "process_stopped_after_dispatch",
        "completion_handling_failed",
        "provider_payment_required",
        "provider_authentication",
    ]) {
        assert.ok(ROUTING_ATTEMPT_ERROR_CLASSES.includes(errorClass), errorClass);
        assert.deepEqual(
            availabilityObservationProblems(ok({ outcome: "failed", errorClass })),
            [`"${errorClass}" is not an availability failure`],
            errorClass
        );
    }
});

test("an observation carries the id a projection is idempotent on", () => {
    assert.deepEqual(availabilityObservationProblems(ok({ eventId: "  " })), [
        "an observation carries the id a projection is idempotent on",
    ]);
});

test("the rule a projection would be idempotent on", () => {
    // Stated ahead of the projection that will use it. What exists today is
    // this predicate and a unique index on the observation; neither makes a
    // rollup safe to re-run, because nothing records what a rollup applied.
    const seen = new Set(["evt_1"]);
    assert.equal(shouldApply("evt_2", seen), true);
    assert.equal(shouldApply("evt_1", seen), false);
    assert.equal(shouldApply("", seen), false);
});

test("a deployment observation names the endpoint it ran on", () => {
    // Otherwise it sits in the deployment view and vanishes from the endpoint
    // view, which reads as an endpoint that had no trouble.
    assert.deepEqual(
        availabilityObservationProblems(ok({ modelDeploymentId: "dep_1" })),
        ["a deployment observation names the endpoint it ran on"]
    );
    assert.deepEqual(
        availabilityObservationProblems(
            ok({ modelDeploymentId: "dep_1", providerEndpointId: "end_1" })
        ),
        []
    );
});

test("an observation rolls up only to grains it actually has", () => {
    // One from before deployments existed contributes to the provider view and
    // to nothing it was never part of. Nothing is backfilled to make it fit.
    assert.deepEqual(rollupGrainsFor({}), ["provider"]);
    assert.deepEqual(rollupGrainsFor({ providerEndpointId: "end_1" }), [
        "endpoint",
        "provider",
    ]);
    assert.deepEqual(
        rollupGrainsFor({ providerEndpointId: "end_1", modelDeploymentId: "dep_1" }),
        ["deployment", "endpoint", "provider"]
    );
});

test("the three sources stay apart", () => {
    // An operator proving the API answers is not the same claim as real user
    // traffic being served, and a synthetic probe is neither.
    assert.deepEqual(
        [...AVAILABILITY_OBSERVATION_SOURCES],
        ["real_traffic", "synthetic_probe", "operator_verification"]
    );
    assert.deepEqual(availabilityObservationProblems(ok({ source: "guess" })), [
        'unknown source "guess"',
    ]);
});

test("the database holds the same rules, and the row cannot be rewritten", () => {
    const sql = migration();
    assert.match(sql, /AvailabilityObservation_error_class_matches_outcome_check/);
    assert.match(sql, /AvailabilityObservation_deployment_has_endpoint_check/);
    assert.match(sql, /AvailabilityObservation_latency_non_negative_check/);
    assert.match(sql, /CREATE UNIQUE INDEX "AvailabilityObservation_eventId_key"/);
    // Append-only: a rollup is derived from these rows, so editing one after
    // the fact changes a summary already read and leaves nothing saying it
    // moved.
    assert.match(sql, /CREATE TRIGGER "availability_observation_is_append_only_trigger"/);
    assert.match(sql, /BEFORE UPDATE OR DELETE ON "AvailabilityObservation"/);
    // TRUNCATE does not fire an ON DELETE trigger, so it needs its own.
    assert.match(sql, /CREATE TRIGGER "availability_observation_is_not_truncatable_trigger"/);
    assert.match(sql, /BEFORE TRUNCATE ON "AvailabilityObservation"/);
});

test("neither existing health table is touched", () => {
    // They are the grain the public status page and the operator recovery path
    // read; this is the grain the router will read. Replacing them here would
    // have cut the router over to a sample that does not exist yet.
    const statements = migration()
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("--"))
        .join("\n");
    for (const table of ["ProviderHealthState", "ProviderProbeResult"]) {
        assert.ok(!statements.includes(table), `${table} is left alone`);
    }
});
