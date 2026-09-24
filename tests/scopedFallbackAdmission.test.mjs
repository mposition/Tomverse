import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { classifyCanonicalFailure } from "../lib/canonicalFailureClassification.ts";
import { MAX_DISPATCHED_ATTEMPTS } from "../lib/routingResidualControls.ts";
import {
    SCOPED_FALLBACK_ATTEMPT_BUDGET,
    admitScopedFallback,
} from "../lib/scopedFallbackAdmission.ts";

const base = {
    provenance: "provider_reported",
    category: "SERVER_ERROR",
    genericScope: "provider",
    providerSide: null,
    gatewayProviderId: "deepinfra",
    servingProviderId: "deepinfra",
    endpointId: "ep_1",
    deploymentId: "dep_1",
    logicalModelId: "deepseek-v4-pro",
};

const candidate = (over = {}) => ({
    deploymentId: "dep_2",
    logicalModelId: "deepseek-v4-pro",
    endpointId: "ep_2",
    gatewayProviderId: "deepinfra",
    ...over,
});

test("the scoped budget is the live two-attempt budget", () => {
    assert.equal(SCOPED_FALLBACK_ATTEMPT_BUDGET, MAX_DISPATCHED_ATTEMPTS);
    assert.equal(SCOPED_FALLBACK_ATTEMPT_BUDGET, 2);
});

test("an endpoint failure admits only a different endpoint, in caller order", () => {
    const failure = classifyCanonicalFailure(base);
    assert.equal(failure.scopeKind, "serving_endpoint");
    const same = candidate({ deploymentId: "dep_same", endpointId: "ep_1" });
    const later = candidate({ deploymentId: "dep_later", endpointId: "ep_3" });
    const first = candidate({ deploymentId: "dep_first", endpointId: "ep_2" });
    const decision = admitScopedFallback({
        failure,
        attemptsDispatched: 1,
        candidates: [same, later, first],
    });
    assert.equal(decision.admitted, true);
    assert.equal(decision.remainingAttempts, 1);
    assert.ok(decision.candidates.length > decision.remainingAttempts);
    assert.deepEqual(
        decision.candidates.map((item) => item.deploymentId),
        ["dep_later", "dep_first"]
    );
});

test("a deployment failure may stay on the same endpoint", () => {
    const failure = classifyCanonicalFailure({
        ...base,
        category: "MODEL_TRANSIENT",
        genericScope: "model",
    });
    assert.equal(failure.scopeKind, "deployment");
    const decision = admitScopedFallback({
        failure,
        attemptsDispatched: 1,
        candidates: [
            candidate({ deploymentId: "dep_1", endpointId: "ep_1" }),
            candidate({ deploymentId: "dep_other", endpointId: "ep_1" }),
        ],
    });
    assert.equal(decision.admitted, true);
    assert.deepEqual(
        decision.candidates.map((item) => item.deploymentId),
        ["dep_other"]
    );
});

test("a gateway failure does not admit another endpoint on that gateway", () => {
    const failure = classifyCanonicalFailure({
        ...base,
        category: "RATE_LIMIT",
        providerSide: "gateway",
        gatewayProviderId: "openrouter",
        servingProviderId: "anthropic",
    });
    assert.equal(failure.scopeKind, "gateway");
    const decision = admitScopedFallback({
        failure,
        attemptsDispatched: 1,
        candidates: [
            candidate({ endpointId: "ep_9", gatewayProviderId: "openrouter" }),
            candidate({ endpointId: "ep_9", gatewayProviderId: "together" }),
        ],
    });
    assert.equal(decision.admitted, true);
    assert.equal(decision.candidates.length, 1);
    assert.equal(decision.candidates[0].gatewayProviderId, "together");
});

test("an abstention admits nobody", () => {
    const failure = classifyCanonicalFailure({
        ...base,
        category: "UNKNOWN",
        genericScope: null,
    });
    assert.equal(failure.status, "abstain");
    assert.deepEqual(
        admitScopedFallback({
            failure,
            attemptsDispatched: 1,
            candidates: [candidate()],
        }),
        { admitted: false, reason: "abstained", remainingAttempts: 0 }
    );
});

test("a second dispatched attempt does not name a third", () => {
    const failure = classifyCanonicalFailure(base);
    assert.deepEqual(
        admitScopedFallback({
            failure,
            attemptsDispatched: 2,
            candidates: [candidate()],
        }),
        { admitted: false, reason: "budget_spent", remainingAttempts: 0 }
    );
});

test("a budget that is not a sent attempt is refused", () => {
    const failure = classifyCanonicalFailure(base);
    for (const attemptsDispatched of [0, -1, 1.5]) {
        assert.equal(
            admitScopedFallback({
                failure,
                attemptsDispatched,
                candidates: [candidate()],
            }).reason,
            "invalid_budget"
        );
    }
});

test("a local failure is not described as the same domain", () => {
    const abort = classifyCanonicalFailure({ ...base, provenance: "user_abort", category: "NETWORK" });
    assert.equal(abort.scopeKind, "local");
    assert.deepEqual(
        admitScopedFallback({
            failure: abort,
            attemptsDispatched: 1,
            candidates: [candidate()],
        }),
        { admitted: false, reason: "local_scope", remainingAttempts: 0 }
    );
    const local = classifyCanonicalFailure({
        ...base,
        category: "LOCAL_REJECTION",
        genericScope: "none",
    });
    assert.equal(
        admitScopedFallback({
            failure: local,
            attemptsDispatched: 1,
            candidates: [candidate()],
        }).reason,
        "local_scope"
    );
});

test("no candidate outside the failed scope stops the chain", () => {
    const failure = classifyCanonicalFailure(base);
    assert.equal(
        admitScopedFallback({
            failure,
            attemptsDispatched: 1,
            candidates: [candidate({ endpointId: "ep_1" })],
        }).reason,
        "same_failure_domain"
    );
    assert.equal(
        admitScopedFallback({
            failure,
            attemptsDispatched: 1,
            candidates: [],
        }).reason,
        "same_failure_domain"
    );
});

test("the request path does not import scoped fallback admission", () => {
    const source = readFileSync(new URL("../lib/scopedFallbackAdmission.ts", import.meta.url), "utf8");
    assert.equal(source.includes("equivalenceClass"), false);
    assert.equal(source.includes("servingContractDigest"), false);
    assert.equal(source.includes("quotaCapacity"), false);
    assert.equal(source.includes("decideFallback"), false);

    const hits = [];
    const walk = (directory) => {
        if (!existsSync(directory)) return;
        for (const name of readdirSync(directory)) {
            const path = join(directory, name);
            if (statSync(path).isDirectory()) {
                if (name === "node_modules" || name === ".next") continue;
                walk(path);
                continue;
            }
            if (!/\.(?:ts|tsx|mjs|js)$/.test(name)) continue;
            if (path === join("lib", "scopedFallbackAdmission.ts")) continue;
            const text = readFileSync(path, "utf8");
            if (text.includes("scopedFallbackAdmission") || text.includes("admitScopedFallback")) {
                hits.push(path);
            }
        }
    };
    for (const root of ["app", "lib", "components", "packages", "apps"]) walk(root);
    assert.deepEqual(hits, []);
});
