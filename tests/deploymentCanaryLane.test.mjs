import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { admitCanaryObservation, canaryRoutingEligibility } from "../lib/deploymentCanaryLane.ts";

const ready = {
    synthetic: true,
    userContentPresent: false,
    residencyProven: true,
    separateCredentialQuota: true,
    separateProviderBudget: true,
    normalRoutingCandidate: false,
};

test("a synthetic observation can be admitted before the window has passed", () => {
    assert.deepEqual(admitCanaryObservation(ready), { admitted: true, routingCandidate: false });
    assert.deepEqual(
        canaryRoutingEligibility({ observationAdmitted: true, observationWindowPassed: null }),
        { routingEligible: false, reason: "observation_window_unproven" }
    );
    assert.deepEqual(
        canaryRoutingEligibility({ observationAdmitted: true, observationWindowPassed: true }),
        { routingEligible: true }
    );
});

test("user content and shared quota are refused, and an unadmitted window does not route", () => {
    assert.equal(admitCanaryObservation({ ...ready, userContentPresent: true }).reason, "user_content");
    assert.equal(admitCanaryObservation({ ...ready, synthetic: false }).reason, "not_synthetic");
    assert.equal(admitCanaryObservation({ ...ready, residencyProven: false }).reason, "residency_unproven");
    assert.equal(
        admitCanaryObservation({ ...ready, separateCredentialQuota: false }).reason,
        "shared_credential_quota"
    );
    assert.equal(
        admitCanaryObservation({ ...ready, separateProviderBudget: false }).reason,
        "shared_provider_budget"
    );
    assert.equal(admitCanaryObservation({ ...ready, normalRoutingCandidate: true }).reason, "routing_candidate");
    assert.equal(
        canaryRoutingEligibility({ observationAdmitted: false, observationWindowPassed: true }).reason,
        "observation_not_admitted"
    );
});

test("the request path does not import the canary lane", () => {
    const hits = [];
    const walk = (directory) => {
        for (const name of readdirSync(directory)) {
            const path = join(directory, name);
            if (statSync(path).isDirectory()) {
                if (name === "node_modules" || name === ".next") continue;
                walk(path);
                continue;
            }
            if (!/\.(?:ts|tsx|mjs|js)$/.test(name)) continue;
            if (path === join("lib", "deploymentCanaryLane.ts")) continue;
            const source = readFileSync(path, "utf8");
            if (
                source.includes("deploymentCanaryLane") ||
                source.includes("admitCanaryObservation") ||
                source.includes("canaryRoutingEligibility")
            ) {
                hits.push(path);
            }
        }
    };
    for (const root of ["app", "lib"]) walk(root);
    assert.deepEqual(hits, []);
});
