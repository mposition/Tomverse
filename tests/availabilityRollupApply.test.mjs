import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { rollupApplicationKey, shouldApplyRollup } from "../lib/availabilityRollupApply.ts";

test("a provider application does not consume the deployment grain", () => {
    const provider = shouldApplyRollup(
        { eventId: "evt_1", grain: "provider", targetId: "deepinfra" },
        new Set()
    );
    assert.equal(provider.apply, true);
    if (!provider.apply) return;
    const deployment = shouldApplyRollup(
        { eventId: "evt_1", grain: "deployment", targetId: "dep_1" },
        new Set([provider.key])
    );
    assert.equal(deployment.apply, true);
    const again = shouldApplyRollup(
        { eventId: "evt_1", grain: "provider", targetId: "deepinfra" },
        new Set([provider.key])
    );
    assert.deepEqual(again, { apply: false, reason: "already_applied" });
});

test("a blank or unknown grain is not treated as already applied", () => {
    assert.equal(shouldApplyRollup({ eventId: " ", grain: "provider", targetId: "deepinfra" }, new Set()).reason, "blank");
    assert.equal(shouldApplyRollup({ eventId: "", grain: "provider", targetId: "deepinfra" }, new Set()).reason, "blank");
    assert.equal(shouldApplyRollup({ eventId: "evt_1", grain: "provider", targetId: "" }, new Set()).reason, "blank");
    assert.equal(
        shouldApplyRollup({ eventId: "evt_1", grain: "region", targetId: "deepinfra" }, new Set()).reason,
        "unknown_grain"
    );
});

test("the key does not join two different triples into one", () => {
    const left = rollupApplicationKey("a:b", "provider", "c");
    const right = rollupApplicationKey("a", "b\nprovider", "c");
    assert.notEqual(left, right);
});

test("the migration records the triple and does not rewrite old observations", () => {
    const sql = readFileSync(
        "prisma/migrations/20260924010000_availability_rollup_application_dark/migration.sql",
        "utf8"
    );
    assert.match(sql, /CREATE TABLE "AvailabilityRollupApplication"/);
    assert.match(sql, /UNIQUE INDEX "AvailabilityRollupApplication_eventId_grain_targetId_key"/);
    assert.match(sql, /"grain" IN \('deployment', 'endpoint', 'provider'\)/);
    assert.doesNotMatch(sql, /\bUPDATE\s+"/);
});

test("the request path does not import the apply rule", () => {
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
            if (path === join("lib", "availabilityRollupApply.ts")) continue;
            const source = readFileSync(path, "utf8");
            if (source.includes("availabilityRollupApply") || source.includes("shouldApplyRollup")) hits.push(path);
        }
    };
    for (const root of ["app", "lib"]) walk(root);
    assert.deepEqual(hits, []);
});
