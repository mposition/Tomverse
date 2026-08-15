import assert from "node:assert/strict";
import test from "node:test";

import {
    auditUnsweptTables,
    BOUNDED_TABLES,
    PENDING_RETENTION_DECISIONS,
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
        // Isolated the same way `retained` already is: the real pending
        // decision names three models this fixture does not have, and its
        // errors are not what this test is about.
        pending: [],
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

/**
 * A hold with a date is a third state, and the date has to do something.
 *
 * The three credit-reservation tables were sitting in the plain unswept list,
 * which reads as "nobody has looked". Someone had: a sweep there is a decision
 * about billing evidence and a user link, owned by finance-ops and
 * privacy/legal together. Recording that as "retained" would have been worse
 * than the list -- retained means kept on purpose, and forever-by-default is
 * exactly what nobody decided.
 */

const RESERVATIONS = [
    "ChatCreditReservation",
    "ImageCreditReservation",
    "MemoryExtractionCreditReservation",
];

const heldModels = RESERVATIONS.map((name) => ({ name, hasUserCascade: true }));
const auditAt = (iso, extra = []) =>
    auditUnsweptTables({
        models: [...heldModels, ...extra],
        created: new Set([...RESERVATIONS, ...extra.map((m) => m.name)]),
        deleted: new Set(),
        bounded: {},
        retained: {},
        now: new Date(iso),
    });

test("a held table is neither unswept nor retained", () => {
    const before = auditAt("2026-08-15T00:00:00Z");
    assert.deepEqual(before.unswept, []);
    assert.deepEqual(before.cascadeOnly, []);
    assert.deepEqual(before.heldTables, RESERVATIONS);
    assert.equal(before.decisions.open.length, 1);
    assert.equal(before.decisions.overdue.length, 0);
});

test("the deadline changes the report on the day it passes", () => {
    // The whole point of the date. A deadline that produces identical output
    // on either side of itself is a comment.
    //
    // 2026-08-28T14:00:00Z is the end of 2026-08-28 in AEST (UTC+10). The
    // instant is in the registry so the answer does not depend on where the
    // reader is sitting.
    assert.equal(auditAt("2026-08-28T13:59:00Z").decisions.overdue.length, 0);
    assert.equal(auditAt("2026-08-28T14:01:00Z").decisions.overdue.length, 1);

    const late = auditAt("2026-09-04T14:00:00Z");
    assert.equal(late.decisions.open.length, 0);
    assert.equal(late.decisions.overdue[0].daysPast, 7);
    // Still held. The promise to decide lapsed; permission to delete was never
    // granted, and an overdue decision must not read as one.
    assert.equal(late.decisions.overdue[0].holds, "no deletion before approval");
    assert.deepEqual(late.heldTables, RESERVATIONS);
});

test("the three reservation tables are one decision, not three", () => {
    // Answered separately, two of them get a policy and the third is found
    // years later. Every question below has the same answer for all three:
    // they differ only in which workflow reserved the credits.
    assert.equal(PENDING_RETENTION_DECISIONS.length, 1);
    const [decision] = PENDING_RETENTION_DECISIONS;
    assert.deepEqual(decision.tables, RESERVATIONS);
    assert.deepEqual(decision.owners, ["finance-ops", "privacy/legal"]);
    // The three questions the policy document requires, plus backups.
    assert.equal(decision.decides.length, 4);
    assert.match(decision.decides.join("\n"), /per status/);
    assert.match(decision.decides.join("\n"), /account deletion/i);
    assert.match(decision.decides.join("\n"), /backups/);
});

test("a table cannot be both held and settled", () => {
    const clash = auditUnsweptTables({
        models: heldModels,
        created: new Set(RESERVATIONS),
        deleted: new Set(),
        bounded: {},
        retained: { ChatCreditReservation: "kept because someone said so" },
        now: new Date("2026-08-15T00:00:00Z"),
    });
    assert.match(
        clash.errors.join("\n"),
        /ChatCreditReservation is held for a pending decision and also registered/
    );
});

test("every held table is a real model", () => {
    // Same guarantee the other two registries already have: an entry naming a
    // model that no longer exists holds nothing, and reads as though it does.
    const missing = auditUnsweptTables({
        models: [{ name: "ChatCreditReservation", hasUserCascade: true }],
        created: new Set(["ChatCreditReservation"]),
        deleted: new Set(),
        bounded: {},
        retained: {},
        now: new Date("2026-08-15T00:00:00Z"),
    });
    assert.match(
        missing.errors.join("\n"),
        /ImageCreditReservation is registered here but is not a model/
    );
});
