import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
    AVAILABILITY_FAILURE_KINDS,
    NON_AVAILABILITY_KINDS,
    availabilityObservationClass,
    nextAvailabilityBreaker,
    rawAvailabilityFailureRisk,
} from "../lib/deploymentAvailability.ts";

test("429 and malformed output are not availability, and a 5xx is", () => {
    assert.equal(availabilityObservationClass("rate_limited"), "excluded");
    assert.equal(availabilityObservationClass("malformed_output"), "excluded");
    for (const kind of AVAILABILITY_FAILURE_KINDS) {
        assert.equal(availabilityObservationClass(kind), "availability", kind);
    }
    assert.equal(availabilityObservationClass("something_else"), "unknown");
    assert.deepEqual(NON_AVAILABILITY_KINDS, ["rate_limited", "malformed_output"]);
});

test("failure risk uses the documented weights and abstains without evidence", () => {
    assert.deepEqual(
        rawAvailabilityFailureRisk({ n5xx: 1, nTimeout: 0, nConnection: 0, nEligible: 4 }),
        { evidence: "measured", risk: 0.25 }
    );
    assert.deepEqual(
        rawAvailabilityFailureRisk({ n5xx: 0, nTimeout: 1, nConnection: 0, nEligible: 1 }),
        { evidence: "measured", risk: 1.2 }
    );
    assert.deepEqual(
        rawAvailabilityFailureRisk({ n5xx: 0, nTimeout: 0, nConnection: 0, nEligible: 0 }),
        { evidence: "insufficient" }
    );
    assert.deepEqual(
        rawAvailabilityFailureRisk({ n5xx: -1, nTimeout: 0, nConnection: 0, nEligible: 3 }),
        { evidence: "insufficient" }
    );
    assert.deepEqual(
        rawAvailabilityFailureRisk({ n5xx: 4, nTimeout: 0, nConnection: 0, nEligible: 1 }),
        { evidence: "insufficient" }
    );
});

test("the breaker grammar does not choose its own trip count", () => {
    assert.equal(
        nextAvailabilityBreaker({ state: "closed", event: "availability_failure" }),
        "closed"
    );
    assert.equal(
        nextAvailabilityBreaker({ state: "closed", event: "availability_failure", trip: true }),
        "open"
    );
    assert.equal(
        nextAvailabilityBreaker({ state: "closed", event: "ignored", trip: true }),
        "closed"
    );
    assert.equal(
        nextAvailabilityBreaker({ state: "open", event: "success" }),
        "open"
    );
    assert.equal(
        nextAvailabilityBreaker({ state: "open", event: "admit_probe" }),
        "half_open"
    );
    assert.equal(
        nextAvailabilityBreaker({ state: "half_open", event: "success" }),
        "closed"
    );
    assert.equal(
        nextAvailabilityBreaker({ state: "half_open", event: "availability_failure" }),
        "open"
    );
    assert.equal(
        nextAvailabilityBreaker({ state: "half_open", event: "ignored" }),
        "half_open"
    );
    assert.equal(nextAvailabilityBreaker({ state: "blown", event: "success" }), null);
    assert.equal(nextAvailabilityBreaker({ state: "closed", event: "other" }), null);
});

test("the request path does not import the deployment breaker", () => {
    const hits = [];
    const walk = (directory) => {
        for (const name of readdirSync(directory)) {
            const path = join(directory, name);
            if (statSync(path).isDirectory()) {
                walk(path);
                continue;
            }
            if (!/\.(?:ts|tsx|mjs|js)$/.test(name)) continue;
            if (path === join("lib", "deploymentAvailability.ts")) continue;
            const source = readFileSync(path, "utf8");
            if (source.includes("deploymentAvailability") || source.includes("nextAvailabilityBreaker")) {
                hits.push(path);
            }
        }
    };
    for (const root of ["app", "lib"]) walk(root);
    assert.deepEqual(hits, []);
});
