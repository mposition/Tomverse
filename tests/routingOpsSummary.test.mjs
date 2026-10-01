import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { routingOpsSummary } from "../lib/routingOpsSummary.ts";

test("a complete sample is a ratio, not a verdict", () => {
    const summary = routingOpsSummary({
        health: { failed: 1, eligible: 4 },
        capacityLimited: false,
        quality: "passed",
    });
    assert.deepEqual(summary, {
        kind: "summary",
        healthFailureRatio: 0.25,
        capacityLimited: false,
        quality: "passed",
    });
    assert.equal("healthy" in summary, false);
});

test("an empty or unusable population is insufficient, not zero", () => {
    assert.deepEqual(
        routingOpsSummary({ health: null, capacityLimited: null, quality: null }),
        { kind: "insufficient", missing: ["health", "capacity", "quality"] }
    );
    assert.deepEqual(
        routingOpsSummary({ health: { failed: 0, eligible: 0 }, capacityLimited: false, quality: "passed" }).missing,
        ["health"]
    );
    assert.equal(
        routingOpsSummary({
            health: { failed: 3, eligible: 2 },
            capacityLimited: true,
            quality: "stale",
        }).kind,
        "insufficient"
    );
    for (const health of [
        { failed: -1, eligible: 1 },
        { failed: 0.5, eligible: 1 },
        { failed: 1, eligible: 1.5 },
    ]) {
        assert.equal(routingOpsSummary({ health, capacityLimited: false, quality: "pending" }).kind, "insufficient");
    }
    assert.equal(
        routingOpsSummary({ health: { failed: 0, eligible: 1 }, capacityLimited: false, quality: "unknown" }).kind,
        "insufficient"
    );
});

test("the request path does not import the summary", () => {
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
            if (path === join("lib", "routingOpsSummary.ts")) continue;
            const source = readFileSync(path, "utf8");
            if (source.includes("routingOpsSummary")) hits.push(path);
        }
    };
    for (const root of ["app", "lib"]) walk(root);
    assert.deepEqual(hits, []);
});
