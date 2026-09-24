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

// A CHECK stores the row when the expression is TRUE or NULL. NULL is not a
// rejection. The first check's positive branch was only the two regexes, so
// a half pair was NULL and was stored. The replacement is FALSE for that row.
const checkWouldStore = (expression) => expression !== false;

const firstPairExpression = (controlPlaneVersion, accountPolicyVersion) => {
    const bothAbsent = controlPlaneVersion === null && accountPolicyVersion === null;
    return sqlOr(
        bothAbsent,
        sqlAnd(nonBlank(controlPlaneVersion), nonBlank(accountPolicyVersion))
    );
};

const replacementPairExpression = (controlPlaneVersion, accountPolicyVersion) => {
    const bothAbsent = controlPlaneVersion === null && accountPolicyVersion === null;
    return sqlOr(
        bothAbsent,
        sqlAnd(
            sqlAnd(controlPlaneVersion !== null, accountPolicyVersion !== null),
            sqlAnd(nonBlank(controlPlaneVersion), nonBlank(accountPolicyVersion))
        )
    );
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
    assert.match(added, /"controlPlaneVersion" ~/);
    assert.match(added, /"accountPolicyVersion" ~/);
    assert.doesNotMatch(added, /IS NOT NULL/);
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
    assert.equal(checkWouldStore(firstPairExpression("manifest-4", null)), true);
    assert.equal(replacementPairExpression("manifest-4", null), false);
    assert.equal(replacementPairExpression(null, "account-policy-2"), false);
    assert.equal(checkWouldStore(replacementPairExpression(null, null)), true);
    assert.equal(checkWouldStore(replacementPairExpression("manifest-4", "account-policy-2")), true);
    assert.equal(replacementPairExpression("   ", "account-policy-2"), false);
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
