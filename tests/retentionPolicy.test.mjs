import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
    RETENTION_POLICIES,
    retentionCutoff,
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
