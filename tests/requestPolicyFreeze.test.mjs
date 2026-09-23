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

const sqlAnd = (left, right) => {
    if (left === false || right === false) return false;
    if (left === true && right === true) return true;
    return null;
};

const sqlOr = (left, right) => {
    if (left === true || right === true) return true;
    if (left === false && right === false) return false;
    return null;
};

const nonBlank = (value) => {
    if (value === null) return null;
    return /[^\t\n\r\f\v ]/.test(value);
};

// The replacement CHECK. A regex on NULL is NULL, and a CHECK passes on
// NULL, so the positive branch has to be FALSE when either column is null.
const pairCheckHolds = (controlPlaneVersion, accountPolicyVersion) => {
    const bothAbsent = controlPlaneVersion === null && accountPolicyVersion === null;
    const positive = sqlAnd(
        sqlAnd(controlPlaneVersion !== null, accountPolicyVersion !== null),
        sqlAnd(nonBlank(controlPlaneVersion), nonBlank(accountPolicyVersion))
    );
    return sqlOr(bothAbsent, positive) === true;
};

test("a returned freeze cannot be overwritten with a later version", () => {
    const freeze = freezeRequestPolicy(observed);
    assert.throws(() => {
        freeze.controlPlaneVersion = "manifest-5";
    });
    assert.equal(freeze.controlPlaneVersion, observed.controlPlaneVersion);
});

test("the columns are nullable and the pair check rejects a half pair", () => {
    const added = readFileSync(
        "prisma/migrations/20260923430000_routing_run_policy_freeze_dark/migration.sql",
        "utf8"
    );
    assert.match(added, /ADD COLUMN "controlPlaneVersion" TEXT/);
    assert.match(added, /ADD COLUMN "accountPolicyVersion" TEXT/);
    assert.doesNotMatch(added, /DEFAULT/);
    assert.doesNotMatch(added, /UPDATE\s+"RoutingRun"/i);

    const replaced = readFileSync(
        "prisma/migrations/20260923450000_routing_run_policy_freeze_pair_check/migration.sql",
        "utf8"
    );
    assert.match(replaced, /DROP CONSTRAINT "RoutingRun_policy_freeze_pair_check"/);
    assert.match(replaced, /"controlPlaneVersion" IS NOT NULL/);
    assert.match(replaced, /"accountPolicyVersion" IS NOT NULL/);
    assert.doesNotMatch(replaced, /UPDATE\s+"RoutingRun"/i);
    assert.equal(pairCheckHolds(null, null), true);
    assert.equal(pairCheckHolds("manifest-4", "account-policy-2"), true);
    assert.equal(pairCheckHolds("manifest-4", null), false);
    assert.equal(pairCheckHolds(null, "account-policy-2"), false);
    assert.equal(pairCheckHolds("   ", "account-policy-2"), false);
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
                source.includes("freezeRequestPolicy") ||
                source.includes("policyVersionsForDecision")
            ) {
                hits.push(path);
            }
        }
    };
    for (const root of ["app", "lib"]) walk(root);
    assert.deepEqual(hits, []);
});
