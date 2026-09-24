import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
    candidateOutsideFailureScope,
    classifyCanonicalFailure,
} from "../lib/canonicalFailureClassification.ts";

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

test("a user abort is local and is not an upstream timeout", () => {
    const abort = classifyCanonicalFailure({ ...base, provenance: "user_abort", category: "NETWORK" });
    assert.equal(abort.status, "classified");
    assert.equal(abort.scopeKind, "local");
    assert.equal(abort.scopeId, "client");
    assert.equal(abort.provenance, "user_abort");
    assert.equal(abort.differentEndpointRequired, false);

    const timeout = classifyCanonicalFailure({
        ...base,
        provenance: "upstream_timeout",
        category: null,
        genericScope: null,
    });
    assert.equal(timeout.scopeKind, "serving_endpoint");
    assert.equal(timeout.scopeId, "ep_1");
    assert.equal(timeout.provenance, "upstream_timeout");
    assert.notEqual(abort.provenance, timeout.provenance);
});

test("an upstream timeout without an endpoint does not blame the gateway", () => {
    assert.equal(
        classifyCanonicalFailure({
            ...base,
            provenance: "upstream_timeout",
            category: "NETWORK",
            endpointId: null,
        }).reason,
        "missing_endpoint"
    );
});

test("a broker path abstains until the caller names the side", () => {
    assert.equal(
        classifyCanonicalFailure({
            ...base,
            category: "AUTHENTICATION",
            endpointId: null,
            gatewayProviderId: "deepinfra",
            servingProviderId: "anthropic",
            providerSide: null,
        }).reason,
        "gateway_serving_unresolved"
    );
    const named = classifyCanonicalFailure({
        ...base,
        category: "AUTHENTICATION",
        endpointId: null,
        gatewayProviderId: "deepinfra",
        servingProviderId: "anthropic",
        providerSide: "gateway",
    });
    assert.equal(named.scopeKind, "gateway");
    assert.equal(named.scopeId, "deepinfra");
});

test("a broker server error abstains until the caller names the side, even with an endpoint", () => {
    assert.equal(
        classifyCanonicalFailure({
            ...base,
            gatewayProviderId: "openrouter",
            servingProviderId: "anthropic",
            providerSide: null,
            endpointId: "ep_1",
            category: "SERVER_ERROR",
        }).reason,
        "gateway_serving_unresolved"
    );
    const namedGateway = classifyCanonicalFailure({
        ...base,
        gatewayProviderId: "openrouter",
        servingProviderId: "anthropic",
        providerSide: "gateway",
        endpointId: "ep_1",
        category: "RATE_LIMIT",
    });
    assert.equal(namedGateway.scopeKind, "gateway");
    assert.equal(namedGateway.scopeId, "openrouter");
    assert.equal(namedGateway.differentEndpointRequired, false);
    assert.equal(
        candidateOutsideFailureScope(namedGateway, {
            deploymentId: "dep_2",
            logicalModelId: "deepseek-v4-pro",
            endpointId: "ep_2",
            gatewayProviderId: "openrouter",
        }).reason,
        "same_scope"
    );
});

test("a server error names the endpoint and does not widen to the provider", () => {
    const classified = classifyCanonicalFailure(base);
    assert.equal(classified.scopeKind, "serving_endpoint");
    assert.equal(classified.scopeId, "ep_1");
    assert.equal(classified.differentEndpointRequired, true);
    assert.equal(
        classifyCanonicalFailure({ ...base, endpointId: null, providerSide: null }).reason,
        "missing_endpoint"
    );
});

test("a missing serving id does not turn a server error into that endpoint", () => {
    assert.equal(
        classifyCanonicalFailure({
            ...base,
            servingProviderId: null,
            providerSide: null,
            endpointId: "ep_1",
            category: "SERVER_ERROR",
        }).reason,
        "gateway_serving_unresolved"
    );
    assert.equal(
        classifyCanonicalFailure({
            ...base,
            gatewayProviderId: null,
            servingProviderId: null,
            providerSide: null,
            endpointId: "ep_1",
            category: "RATE_LIMIT",
        }).reason,
        "gateway_serving_unresolved"
    );
});

test("UNKNOWN abstains instead of taking a scope", () => {
    assert.equal(classifyCanonicalFailure({ ...base, category: "UNKNOWN" }).reason, "insufficient");
});

test("a model failure names the deployment or abstains", () => {
    const classified = classifyCanonicalFailure({
        ...base,
        category: "MODEL_NOT_FOUND",
        genericScope: "model",
    });
    assert.equal(classified.scopeKind, "deployment");
    assert.equal(classified.scopeId, "dep_1");
    assert.equal(
        classifyCanonicalFailure({
            ...base,
            category: "MODEL_NOT_FOUND",
            genericScope: "model",
            deploymentId: null,
        }).reason,
        "missing_deployment"
    );
});

test("a disagreed generic scope abstains", () => {
    assert.equal(
        classifyCanonicalFailure({ ...base, category: "SERVER_ERROR", genericScope: "model" }).reason,
        "scope_disagreement"
    );
});

test("another endpoint is outside an endpoint failure, and an abstention clears nobody", () => {
    const failure = classifyCanonicalFailure(base);
    assert.deepEqual(
        candidateOutsideFailureScope(failure, {
            deploymentId: "dep_2",
            logicalModelId: "deepseek-v4-pro",
            endpointId: "ep_2",
            gatewayProviderId: "deepinfra",
        }),
        { outside: true }
    );
    assert.equal(
        candidateOutsideFailureScope(failure, {
            deploymentId: "dep_2",
            logicalModelId: "other-model",
            endpointId: "ep_1",
            gatewayProviderId: "deepinfra",
        }).reason,
        "same_scope"
    );
    const abstained = classifyCanonicalFailure({ ...base, category: "UNKNOWN" });
    assert.equal(
        candidateOutsideFailureScope(abstained, {
            deploymentId: "dep_2",
            logicalModelId: "other",
            endpointId: "ep_2",
            gatewayProviderId: "other",
        }).reason,
        "unclassified"
    );
});

test("the request path does not import the canonical classifier", () => {
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
            if (path === join("lib", "canonicalFailureClassification.ts")) continue;
            if (path === join("lib", "scopedFallbackAdmission.ts")) continue;
            const source = readFileSync(path, "utf8");
            if (
                source.includes("canonicalFailureClassification") ||
                source.includes("classifyCanonicalFailure") ||
                source.includes("candidateOutsideFailureScope")
            ) {
                hits.push(path);
            }
        }
    };
    for (const root of ["app", "lib"]) walk(root);
    assert.deepEqual(hits, []);
});
