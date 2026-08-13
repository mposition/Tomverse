import assert from "node:assert/strict";
import test from "node:test";

import {
    auditUnsweptTables,
    BOUNDED_TABLES,
    RETAINED_TABLES,
} from "../scripts/report-unswept-tables-core.mjs";

/**
 * The survey that found three tables nothing would ever remove a row from.
 *
 * `ProviderProbeResult` was the worst of them: a row per probed model every
 * ten minutes, and no code anywhere reads the table -- the probe's own failure
 * path logs and moves the provider's health counters, and the write site says
 * so in a comment. It had no ceiling and no audience.
 *
 * What is asserted here is the classification, not the sweep. A table can
 * leave the list three ways and only two of them are mechanical; the third is
 * a person writing down why, which is what the registries are.
 */

const model = (name, hasUserCascade = false) => ({ name, hasUserCascade });

test("a table written and never deleted from is reported", () => {
    const { unswept } = auditUnsweptTables({
        models: [model("ProbeResult")],
        created: new Set(["ProbeResult"]),
        deleted: new Set(),
        bounded: {},
        retained: {},
    });
    assert.deepEqual(unswept, ["ProbeResult"]);
});

test("a cascade is reported separately, because it answers a different question", () => {
    // "Removed with the account" and "stops growing" are not the same claim. A
    // table with a row per request still grows without limit for as long as the
    // account exists, and folding it into the swept set would hide exactly the
    // tables most worth looking at.
    const { unswept, cascadeOnly } = auditUnsweptTables({
        models: [model("RoutingAttempt", true)],
        created: new Set(["RoutingAttempt"]),
        deleted: new Set(),
        bounded: {},
        retained: {},
    });
    assert.deepEqual(unswept, []);
    assert.deepEqual(cascadeOnly, ["RoutingAttempt"]);
});

test("a table the application deletes from is not reported at all", () => {
    const { unswept, cascadeOnly } = auditUnsweptTables({
        models: [model("Swept")],
        created: new Set(["Swept"]),
        deleted: new Set(["Swept"]),
        bounded: {},
        retained: {},
    });
    assert.deepEqual(unswept, []);
    assert.deepEqual(cascadeOnly, []);
});

test("a table nothing writes to is not this survey's business", () => {
    const { unswept } = auditUnsweptTables({
        models: [model("NeverWritten")],
        created: new Set(),
        deleted: new Set(),
        bounded: {},
        retained: {},
    });
    assert.deepEqual(unswept, []);
});

test("a registry entry for a table that no longer exists is an error", () => {
    // The failure mode a registry has: the exemption outliving its subject, so
    // the list quietly stops covering what it claims to.
    const { errors } = auditUnsweptTables({
        models: [model("Real")],
        created: new Set(["Real"]),
        deleted: new Set(["Real"]),
        bounded: { Gone: "used to be one row per provider" },
        retained: {},
    });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /Gone is registered here but is not a model/);
});

test("a table cannot be both bounded and retained", () => {
    const { errors } = auditUnsweptTables({
        models: [model("Both")],
        created: new Set(["Both"]),
        deleted: new Set(),
        bounded: { Both: "one row per key" },
        retained: { Both: "billing record" },
    });
    assert.ok(errors.some((message) => /both bounded and retained/.test(message)));
});

test("every registry entry says what the ceiling is, or why there is none", () => {
    for (const [name, reason] of Object.entries(BOUNDED_TABLES)) {
        assert.ok(
            reason && reason.length > 15,
            `${name} needs a ceiling, not a label. "It is small today" is not one.`
        );
    }
    for (const [name, reason] of Object.entries(RETAINED_TABLES)) {
        assert.ok(
            reason && reason.length > 15,
            `${name} needs the reason deleting a row would be wrong`
        );
    }
});

test("the audit log is retained, and the reason is the one that matters", () => {
    // Named rather than left to the loop: a future "tidy old audit rows" sweep
    // is the specific mistake this entry exists to refuse.
    assert.match(RETAINED_TABLES.AdminAuditLog, /hash chain/);
});
