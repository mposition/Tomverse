import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { DEPLOYMENT_QUALITY_GATE_STATUSES } from "../lib/deploymentIdentity.ts";
import {
    QUALITY_DRIFT_SIGNALS,
    driftRevalidationDue,
    effectiveQualityGateStatus,
    qualityGateAdmitsProduction,
    qualityGateExpiryWrite,
} from "../lib/qualityGateOperations.ts";

const at = new Date("2026-09-23T00:00:00.000Z");
const later = new Date("2026-10-01T00:00:00.000Z");
const earlier = new Date("2026-09-01T00:00:00.000Z");

test("pending, failed and stale do not move with the clock", () => {
    for (const status of ["pending", "failed", "stale"]) {
        assert.equal(
            effectiveQualityGateStatus({ status, expiresAt: earlier, at }),
            status
        );
    }
});

test("a pass is stale at the expiry instant and after it", () => {
    assert.equal(
        effectiveQualityGateStatus({ status: "passed", expiresAt: later, at }),
        "passed"
    );
    assert.equal(
        effectiveQualityGateStatus({ status: "passed", expiresAt: at, at }),
        "stale"
    );
    assert.equal(
        effectiveQualityGateStatus({ status: "passed", expiresAt: earlier, at }),
        "stale"
    );
});

test("a pass with no expiry is not rewritten, and an unknown status is not a pass", () => {
    assert.equal(
        effectiveQualityGateStatus({ status: "passed", expiresAt: null, at }),
        "passed"
    );
    assert.equal(
        effectiveQualityGateStatus({ status: "passed", at }),
        "passed"
    );
    assert.equal(
        effectiveQualityGateStatus({
            status: "passed",
            expiresAt: new Date(Number.NaN),
            at,
        }),
        "passed"
    );
    assert.equal(effectiveQualityGateStatus({ status: "withdrawn", expiresAt: later, at }), null);
    assert.equal(effectiveQualityGateStatus({ status: null, at }), null);
});

test("production admission is the tier match and a pass that has not expired", () => {
    const base = {
        requiredQualityTier: "standard",
        qualityTier: "standard",
        status: "passed",
        expiresAt: later,
        at,
    };
    assert.equal(qualityGateAdmitsProduction(base), true);
    assert.equal(qualityGateAdmitsProduction({ ...base, expiresAt: at }), false);
    assert.equal(qualityGateAdmitsProduction({ ...base, expiresAt: null }), false);
    assert.equal(qualityGateAdmitsProduction({ ...base, qualityTier: "premium" }), false);
    assert.equal(qualityGateAdmitsProduction({ ...base, requiredQualityTier: "  " }), false);
    assert.equal(qualityGateAdmitsProduction({ ...base, status: "stale" }), false);
    assert.equal(qualityGateAdmitsProduction({ ...base, status: "pending" }), false);
    assert.equal(
        qualityGateAdmitsProduction({ ...base, requiredQualityTier: " standard" }),
        true
    );
});

test("an expiry write disables the row and sets stale, and only then", () => {
    assert.deepEqual(
        qualityGateExpiryWrite({ status: "passed", expiresAt: earlier, at }),
        { qualityGateStatus: "stale", enabled: false }
    );
    assert.equal(
        qualityGateExpiryWrite({ status: "passed", expiresAt: later, at }),
        null
    );
    assert.equal(
        qualityGateExpiryWrite({ status: "stale", expiresAt: earlier, at }),
        null
    );
    assert.equal(
        qualityGateExpiryWrite({ status: "passed", expiresAt: null, at }),
        null
    );
});

test("drift schedules a re-gate only from an exceeded or unknown signal", () => {
    assert.equal(driftRevalidationDue([]), false);
    assert.equal(
        driftRevalidationDue([{ signal: "malformed_output_rate", exceeded: false }]),
        false
    );
    assert.equal(
        driftRevalidationDue([{ signal: "tool_call_exactness", exceeded: true }]),
        true
    );
    assert.equal(
        driftRevalidationDue([{ signal: "not-a-signal", exceeded: false }]),
        true
    );
    assert.deepEqual(QUALITY_DRIFT_SIGNALS.length, 7);
});

test("the status vocabulary still contains stale as its own value", () => {
    assert.deepEqual(DEPLOYMENT_QUALITY_GATE_STATUSES, [
        "pending",
        "passed",
        "failed",
        "stale",
    ]);
});

test("the request path does not import the quality gate", () => {
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
            if (path === join("lib", "qualityGateOperations.ts")) continue;
            const source = readFileSync(path, "utf8");
            if (
                source.includes("qualityGateOperations") ||
                source.includes("effectiveQualityGateStatus") ||
                source.includes("qualityGateAdmitsProduction")
            ) {
                hits.push(path);
            }
        }
    };
    for (const root of roots) walk(root);
    assert.deepEqual(hits, []);
});
