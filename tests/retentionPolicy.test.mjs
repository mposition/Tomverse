import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
    RETENTION_POLICIES,
    RETENTION_SWEEP_GRACE_DAYS,
    retentionCutoff,
    retentionOverdueCutoff,
    retentionPolicy,
} from "../lib/retentionPolicyCore.ts";

/**
 * Every retention policy the Admin Console publishes must be performed by
 * something.
 *
 * Two of the nine were not. `/admin/retention` said alert delivery logs are
 * deleted after 90 days and provider check records after 30, and counted the
 * rows past each cutoff; `cleanupExpiredData()` deleted neither table. The
 * count climbed, an operator typed RUN CLEANUP, and the number stayed where it
 * was -- with nothing on screen to distinguish "the sweep found nothing" from
 * "no sweep exists".
 *
 * That is a worse failure than a missing policy. A retention statement is the
 * kind of thing that gets quoted to a customer, and both halves of this one
 * looked complete: a sentence with a number, and a count that moved.
 */

const MAINTENANCE = readFileSync(
    fileURLToPath(new URL("../lib/maintenance.ts", import.meta.url)),
    "utf8"
);
const RETENTION_ROUTE = readFileSync(
    fileURLToPath(new URL("../app/api/admin/retention/route.ts", import.meta.url)),
    "utf8"
);

/** The step names `cleanupExpiredData` actually runs. */
const maintenanceSteps = new Set(
    [...MAINTENANCE.matchAll(/\bstep\(\s*"([a-z0-9_]+)"/g)].map((match) => match[1])
);

test("the sweep is read at all, so a passing run cannot mean an empty set", () => {
    assert.ok(
        maintenanceSteps.size >= 15,
        `only ${maintenanceSteps.size} maintenance step(s) found; the parser has stopped matching`
    );
});

test("every policy that removes or changes data names a step that runs", () => {
    const unperformed = RETENTION_POLICIES.filter(
        (policy) =>
            policy.action !== "keep" &&
            (!policy.maintenanceStep || !maintenanceSteps.has(policy.maintenanceStep))
    ).map((policy) => `${policy.key} -> ${policy.maintenanceStep ?? "(none)"}`);

    assert.deepEqual(
        unperformed,
        [],
        `${unperformed.join(", ")}: the screen publishes this policy and no ` +
            `maintenance step performs it. Add the step, or change the policy to ` +
            `say what actually happens.`
    );
});

test("a keep policy names no step, because nothing may quietly start deleting", () => {
    for (const policy of RETENTION_POLICIES.filter((entry) => entry.action === "keep")) {
        assert.equal(
            policy.maintenanceStep,
            null,
            `${policy.key} is a keep policy and must not name a sweep step`
        );
    }
});

test("the audit log is the keep policy, and says so where it is read", () => {
    // Named rather than left to the loop above: the hash chain is what makes
    // the log tamper-evident, so deleting an entry from the middle of it breaks
    // every later link. A future sweep that "tidies old audit rows" is the
    // specific mistake this pins.
    const audit = retentionPolicy("auditLogs");
    assert.equal(audit.action, "keep");
    assert.match(audit.policy, /Nothing deletes them/);
});

test("every policy the screen measures is one the policy list defines", () => {
    // The screen builds its rows from the keys it measured, so a key with no
    // policy throws at request time rather than rendering a blank sentence.
    const measured = [
        ...RETENTION_ROUTE.matchAll(/^\s{6}([a-zA-Z]+): \{ staleCount/gm),
        ...RETENTION_ROUTE.matchAll(/^\s{6}([a-zA-Z]+): \{$/gm),
    ].map((match) => match[1]);
    assert.ok(measured.length >= 5, `parsed only ${measured.length} measured key(s)`);
    for (const key of measured) {
        assert.doesNotThrow(
            () => retentionPolicy(key),
            `${key} is measured by /admin/retention with no policy behind it`
        );
    }
});

test("a window is a window, and a policy without one refuses to invent a date", () => {
    const now = new Date("2026-08-13T00:00:00.000Z");
    assert.equal(
        retentionCutoff("providerChecks", now).toISOString(),
        "2026-07-14T00:00:00.000Z"
    );
    assert.equal(
        retentionCutoff("notificationLogs", now).toISOString(),
        "2026-05-15T00:00:00.000Z"
    );
    // `requestLeases` expires per row, so there is no age to compute. Returning
    // "now" instead would delete every lease.
    assert.throws(() => retentionCutoff("requestLeases", now), /no age window/);
});

test("policy keys are unique, and each carries a sentence rather than a label", () => {
    const keys = RETENTION_POLICIES.map((policy) => policy.key);
    assert.equal(new Set(keys).size, keys.length, "duplicate policy key");
    for (const policy of RETENTION_POLICIES) {
        assert.ok(
            policy.policy.length > 20 && /[.]$/.test(policy.policy),
            `${policy.key} needs a sentence an operator can act on`
        );
    }
});

test("overdue is later than the cutoff, by the sweep's own cadence", () => {
    // The distinction this pair exists to draw. `retentionCutoff` is the age
    // the policy states and the sweep deletes at; `retentionOverdueCutoff` is
    // the age past which the sweep has demonstrably not done it.
    const now = new Date("2026-08-13T00:00:00.000Z");
    assert.equal(
        retentionCutoff("providerErrors", now).toISOString(),
        "2026-07-14T00:00:00.000Z"
    );
    assert.equal(
        retentionOverdueCutoff("providerErrors", now).toISOString(),
        "2026-07-12T00:00:00.000Z"
    );
    assert.ok(
        retentionOverdueCutoff("providerErrors", now) <
            retentionCutoff("providerErrors", now),
        "overdue must be the older date, or it would fire sooner than the policy"
    );
});

test("the grace covers more than one scheduled sweep", () => {
    // One day puts the boundary exactly where the daily cron runs, so a slow
    // run flips the alarm on and off around 03:00. The value has to clear a
    // whole sweep interval and then some, or the alarm measures the clock.
    assert.ok(
        RETENTION_SWEEP_GRACE_DAYS > 1,
        "a one-day grace lands on the sweep time itself"
    );
    // And it must stay small enough that a stopped sweep still surfaces
    // quickly. A week of silence is not a monitor.
    assert.ok(RETENTION_SWEEP_GRACE_DAYS <= 3);
});

test("the grace is a monitoring threshold and never extends a retention promise", () => {
    // The reason to be explicit: `retentionOverdueCutoff` must not become the
    // age anything deletes at, or the published "older than 30 days" sentence
    // quietly becomes 32 and the policy stops being true.
    const MONITORING_ONLY = /retentionOverdueCutoff/;
    assert.ok(
        !MONITORING_ONLY.test(MAINTENANCE),
        "the sweep must delete at the policy cutoff, not at the overdue one"
    );
    assert.ok(
        !MONITORING_ONLY.test(RETENTION_ROUTE),
        "/admin/retention counts what the policy covers, not what is late"
    );
});

test("a policy with no window has no overdue date either", () => {
    assert.throws(
        () => retentionOverdueCutoff("requestLeases", new Date()),
        /no age window/
    );
});
