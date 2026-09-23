import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
    freezeRequestPolicy,
    policyVersionsForDecision,
    requestPolicyFreezeHeld,
} from "../lib/routingPinGate.ts";

const observed = {
    controlPlaneVersion: "manifest-4",
    accountPolicyVersion: "account-policy-2",
};

test("a request freezes both versions exactly as they were read", () => {
    const freeze = freezeRequestPolicy(observed);
    assert.deepEqual(freeze, observed);
    assert.deepEqual(policyVersionsForDecision(freeze), observed);
    assert.equal(
        requestPolicyFreezeHeld({
            freeze,
            currentControlPlaneVersion: observed.controlPlaneVersion,
            currentAccountPolicyVersion: observed.accountPolicyVersion,
        }),
        true
    );
});

test("one side, a blank side, or a non-string is not a freeze", () => {
    assert.equal(
        freezeRequestPolicy({
            controlPlaneVersion: observed.controlPlaneVersion,
            accountPolicyVersion: null,
        }),
        null
    );
    assert.equal(
        freezeRequestPolicy({
            controlPlaneVersion: "  ",
            accountPolicyVersion: observed.accountPolicyVersion,
        }),
        null
    );
    assert.equal(
        freezeRequestPolicy({
            controlPlaneVersion: observed.controlPlaneVersion,
            accountPolicyVersion: 2,
        }),
        null
    );
    assert.equal(policyVersionsForDecision(null), null);
    assert.equal(
        policyVersionsForDecision({
            controlPlaneVersion: observed.controlPlaneVersion,
            accountPolicyVersion: "",
        }),
        null
    );
});

test("a promotion during the request does not replace the freeze", () => {
    const freeze = freezeRequestPolicy({
        controlPlaneVersion: " manifest-4 ",
        accountPolicyVersion: observed.accountPolicyVersion,
    });
    assert.equal(freeze.controlPlaneVersion, " manifest-4 ");
    assert.deepEqual(policyVersionsForDecision(freeze), freeze);
    assert.equal(
        requestPolicyFreezeHeld({
            freeze,
            currentControlPlaneVersion: "manifest-5",
            currentAccountPolicyVersion: observed.accountPolicyVersion,
        }),
        false
    );
    assert.equal(
        requestPolicyFreezeHeld({
            freeze,
            currentControlPlaneVersion: freeze.controlPlaneVersion,
            currentAccountPolicyVersion: "account-policy-3",
        }),
        false
    );
    assert.equal(
        requestPolicyFreezeHeld({
            freeze: null,
            currentControlPlaneVersion: observed.controlPlaneVersion,
            currentAccountPolicyVersion: observed.accountPolicyVersion,
        }),
        false
    );
});

test("the columns are a pair, nullable, and written by nobody", () => {
    const sql = readFileSync(
        "prisma/migrations/20260923430000_routing_run_policy_freeze_dark/migration.sql",
        "utf8"
    );
    assert.match(sql, /ADD COLUMN "controlPlaneVersion" TEXT/);
    assert.match(sql, /ADD COLUMN "accountPolicyVersion" TEXT/);
    assert.doesNotMatch(sql, /DEFAULT/);
    assert.match(sql, /"controlPlaneVersion" IS NULL/);
    assert.match(sql, /"accountPolicyVersion" IS NULL/);
    assert.match(sql, /"controlPlaneVersion" ~ /);
    assert.match(sql, /"accountPolicyVersion" ~ /);
    assert.doesNotMatch(sql, /UPDATE\s+"RoutingRun"/i);
});

test("the request path does not import the freeze", () => {
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
            if (
                source.includes("requestPolicyFreeze") ||
                source.includes("freezeRequestPolicy")
            ) {
                hits.push(path);
            }
        }
    };
    for (const root of ["app", "lib"]) walk(root);
    assert.deepEqual(hits, []);
});
