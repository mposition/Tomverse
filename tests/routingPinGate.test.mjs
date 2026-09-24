import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
    PIN_FALLBACK_POLICIES,
    PIN_SCOPES,
    decideRoutingPin,
    pinPermitsGeneralPool,
    pinPolicyVersionHeld,
} from "../lib/routingPinGate.ts";

const candidate = { providerId: "deepinfra", deploymentId: "dep_1" };

test("no pin leaves the candidate unrestricted", () => {
    assert.deepEqual(decideRoutingPin(null, candidate), { pinned: false });
    assert.deepEqual(decideRoutingPin(undefined, candidate), { pinned: false });
});

test("a provider pin accepts only that provider and turns exploration off", () => {
    const decision = decideRoutingPin(
        { scope: "provider", providerId: "deepinfra" },
        candidate
    );
    assert.deepEqual(decision, {
        pinned: true,
        eligible: true,
        exploreRate: 0,
        fallbackPolicy: "error",
    });
    assert.equal(
        decideRoutingPin(
            { scope: "provider", providerId: "together" },
            candidate
        ).eligible,
        false
    );
});

test("a deployment pin accepts only that deployment", () => {
    assert.equal(
        decideRoutingPin(
            { scope: "deployment", deploymentId: "dep_1" },
            candidate
        ).eligible,
        true
    );
    assert.equal(
        decideRoutingPin(
            { scope: "deployment", deploymentId: "dep_2", providerId: "deepinfra" },
            candidate
        ).eligible,
        false
    );
});

test("an unknown scope or a blank target accepts nobody", () => {
    assert.equal(
        decideRoutingPin({ scope: "region", providerId: "deepinfra" }, candidate).eligible,
        false
    );
    assert.equal(
        decideRoutingPin({ scope: "provider", providerId: "  " }, candidate).eligible,
        false
    );
    assert.equal(
        decideRoutingPin({ scope: "deployment", deploymentId: "" }, candidate).eligible,
        false
    );
});

test("only an explicit allow may leave the pin, and only on a miss", () => {
    const miss = decideRoutingPin(
        { scope: "provider", providerId: "together", fallbackPolicy: "allow" },
        candidate
    );
    assert.equal(pinPermitsGeneralPool(miss), true);
    const hit = decideRoutingPin(
        { scope: "provider", providerId: "deepinfra", fallbackPolicy: "allow" },
        candidate
    );
    assert.equal(pinPermitsGeneralPool(hit), false);
    const refused = decideRoutingPin(
        { scope: "provider", providerId: "together", fallbackPolicy: "error" },
        candidate
    );
    assert.equal(pinPermitsGeneralPool(refused), false);
    const folded = decideRoutingPin(
        { scope: "provider", providerId: "together", fallbackPolicy: "Allow" },
        candidate
    );
    assert.equal(folded.fallbackPolicy, "error");
    assert.equal(pinPermitsGeneralPool(folded), false);
});

test("a policy version holds only when both sides are the same present value", () => {
    assert.equal(
        pinPolicyVersionHeld({
            admittedPolicyVersion: "v3",
            currentPolicyVersion: "v3",
        }),
        true
    );
    assert.equal(
        pinPolicyVersionHeld({
            admittedPolicyVersion: "v3",
            currentPolicyVersion: "v4",
        }),
        false
    );
    assert.equal(
        pinPolicyVersionHeld({
            admittedPolicyVersion: null,
            currentPolicyVersion: "v3",
        }),
        false
    );
    assert.equal(
        pinPolicyVersionHeld({
            admittedPolicyVersion: "  ",
            currentPolicyVersion: "  ",
        }),
        false
    );
});

test("the vocabularies are the two scopes and the two fallback policies", () => {
    assert.deepEqual(PIN_SCOPES, ["provider", "deployment"]);
    assert.deepEqual(PIN_FALLBACK_POLICIES, ["error", "allow"]);
});

test("the request path does not import the pin gate", () => {
    const roots = ["app", "lib"];
    const hits = [];
    const walk = (directory) => {
        for (const name of readdirSync(directory)) {
            const path = join(directory, name);
            if (statSync(path).isDirectory()) {
                walk(path);
                continue;
            }
            if (!/\.(?:ts|tsx|mjs|js)$/.test(name)) continue;
            if (path === join("lib", "routingPinGate.ts")) continue;
            const source = readFileSync(path, "utf8");
            if (source.includes("routingPinGate") || source.includes("decideRoutingPin")) {
                hits.push(path);
            }
        }
    };
    for (const root of roots) walk(root);
    assert.deepEqual(hits, []);
});
