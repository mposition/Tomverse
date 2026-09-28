import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { capacityRefusal } from "../lib/quotaCapacity.ts";
import { MAX_MODEL_FALLBACKS } from "../lib/routingFallbackPolicy.ts";
import {
    MAX_DISPATCHED_ATTEMPTS,
    currentRequestSleepsForRetryAfter,
    displaceSessionAffinity,
    orderFallbackByFailureDomain,
    requestDeadlineReached,
} from "../lib/routingResidualControls.ts";

const at = new Date("2026-09-23T00:00:00.000Z");
const later = new Date("2026-09-23T00:00:10.000Z");

test("the first placement is epoch 0 and a displacement needs a supplied window", () => {
    const placed = displaceSessionAffinity({
        current: null,
        nextDeploymentId: "dep_a",
        holdDownUntil: null,
        at,
    });
    assert.deepEqual(placed, { ok: true, affinity: { deploymentId: "dep_a", epoch: 0 } });

    assert.deepEqual(
        displaceSessionAffinity({
            current: placed.affinity,
            nextDeploymentId: "dep_b",
            holdDownUntil: null,
            at,
        }),
        { ok: false, reason: "duration_unspecified" }
    );
    assert.deepEqual(
        displaceSessionAffinity({
            current: placed.affinity,
            nextDeploymentId: "dep_b",
            holdDownUntil: later,
            at,
        }),
        { ok: false, reason: "hold_down" }
    );
    assert.deepEqual(
        displaceSessionAffinity({
            current: placed.affinity,
            nextDeploymentId: "dep_b",
            holdDownUntil: at,
            at,
        }),
        { ok: true, affinity: { deploymentId: "dep_b", epoch: 1 } }
    );
    assert.deepEqual(
        displaceSessionAffinity({
            current: { deploymentId: "dep_a", epoch: 4 },
            nextDeploymentId: "dep_a",
            holdDownUntil: null,
            at,
        }),
        { ok: true, affinity: { deploymentId: "dep_a", epoch: 4 } }
    );
    assert.equal(
        displaceSessionAffinity({
            current: null,
            nextDeploymentId: "  ",
            holdDownUntil: null,
            at,
        }).ok,
        false
    );
});

test("Retry-After does not delay this request, and a missing deadline does not fire", () => {
    assert.equal(currentRequestSleepsForRetryAfter, false);
    assert.equal(MAX_DISPATCHED_ATTEMPTS, MAX_MODEL_FALLBACKS + 1);
    assert.equal(MAX_DISPATCHED_ATTEMPTS, 2);
    assert.equal(
        capacityRefusal({ retryAfterUntil: later }, at),
        "retry_after"
    );
    assert.equal(
        requestDeadlineReached({ startedAt: at, deadlineMs: null, now: later }),
        null
    );
    assert.equal(
        requestDeadlineReached({ startedAt: at, deadlineMs: 1000, now: new Date(at.getTime() + 999) }),
        false
    );
    assert.equal(
        requestDeadlineReached({ startedAt: at, deadlineMs: 1000, now: new Date(at.getTime() + 1000) }),
        true
    );
});

test("a fallback chain prefers a different failure domain and keeps order inside a group", () => {
    const failed = { provider: "openai", apiBaseUrl: "https://api.openai.com/v1", apiKeyEnvName: "OPENAI_API_KEY" };
    const same = { provider: "openai", apiBaseUrl: "https://api.openai.com/v1", apiKeyEnvName: "OPENAI_API_KEY", id: "same" };
    const otherHost = { provider: "openai", apiBaseUrl: "https://api.deepinfra.com/v1/openai", apiKeyEnvName: "OPENAI_API_KEY", id: "host" };
    const otherKey = { provider: "openai", apiBaseUrl: "https://api.openai.com/v1", apiKeyEnvName: "DEEPINFRA_API_KEY", id: "key" };
    assert.deepEqual(
        orderFallbackByFailureDomain(failed, [same, otherHost, otherKey]).map((item) => item.id),
        ["host", "key", "same"]
    );
});

test("the columns are nullable, unchecked when absent, and written by nobody", () => {
    const sql = readFileSync(
        "prisma/migrations/20260923440000_routing_residual_controls_dark/migration.sql",
        "utf8"
    );
    assert.match(sql, /ADD COLUMN "affinityEpoch" INTEGER/);
    assert.match(sql, /ADD COLUMN "holdDownUntil" TIMESTAMP\(3\)/);
    assert.match(sql, /ADD COLUMN "requestDeadlineMs" INTEGER/);
    assert.doesNotMatch(sql, /DEFAULT/);
    assert.match(sql, /"affinityEpoch" IS NULL OR "affinityEpoch" >= 0/);
    assert.match(sql, /"requestDeadlineMs" IS NULL OR "requestDeadlineMs" > 0/);
    assert.doesNotMatch(sql, /UPDATE\s+"/i);
});

test("the request path does not import these controls", () => {
    const hits = [];
    const walk = (directory) => {
        for (const name of readdirSync(directory)) {
            const path = join(directory, name);
            if (statSync(path).isDirectory()) {
                walk(path);
                continue;
            }
            if (!/\.(?:ts|tsx|mjs|js)$/.test(name)) continue;
            if (path === join("lib", "routingResidualControls.ts")) continue;
            const source = readFileSync(path, "utf8");
            if (
                source.includes("routingResidualControls") ||
                source.includes("displaceSessionAffinity") ||
                source.includes("requestDeadlineMs")
            ) {
                hits.push(path);
            }
        }
    };
    for (const root of ["app", "lib"]) walk(root);
    assert.deepEqual(hits, []);
});
