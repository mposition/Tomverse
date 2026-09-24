import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { admitCanaryLane } from "../lib/deploymentCanaryLane.ts";

const ready = {
    synthetic: true,
    userContentPresent: false,
    residencyProven: true,
    separateCredentialQuota: true,
    separateProviderBudget: true,
    normalRoutingCandidate: false,
    observationWindowPassed: true,
};

test("a fully proven synthetic lane is admitted and is not a routing candidate", () => {
    assert.deepEqual(admitCanaryLane(ready), { admitted: true, routingCandidate: false });
});

test("user content, shared quota, and an unproven window are refused", () => {
    assert.equal(admitCanaryLane({ ...ready, userContentPresent: true }).reason, "user_content");
    assert.equal(admitCanaryLane({ ...ready, synthetic: false, userContentPresent: false }).reason, "not_synthetic");
    assert.equal(admitCanaryLane({ ...ready, residencyProven: false }).reason, "residency_unproven");
    assert.equal(
        admitCanaryLane({ ...ready, separateCredentialQuota: false }).reason,
        "shared_credential_quota"
    );
    assert.equal(
        admitCanaryLane({ ...ready, separateProviderBudget: false }).reason,
        "shared_provider_budget"
    );
    assert.equal(admitCanaryLane({ ...ready, normalRoutingCandidate: true }).reason, "routing_candidate");
    assert.equal(admitCanaryLane({ ...ready, observationWindowPassed: null }).reason, "observation_window_unproven");
    assert.equal(admitCanaryLane({ ...ready, observationWindowPassed: false }).reason, "observation_window_unproven");
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
            if (source.includes("deploymentCanaryLane") || source.includes("admitCanaryLane")) hits.push(path);
        }
    };
    for (const root of ["app", "lib"]) walk(root);
    assert.deepEqual(hits, []);
});
