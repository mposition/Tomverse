import assert from "node:assert/strict";
import { test } from "node:test";

import {
    isTriggerMode,
    scheduleProblems,
    scheduleRefusal,
    TRIGGER_MODES,
} from "../lib/emailCampaignScheduleCore.ts";

// When a wave is due, and what a scheduler may do without a person
// (EM-01 slice 4).
//
// Contract: .github/audits/model-lifecycle-email-2026-08-22.md §12.2, §13.3.

const NOW = new Date("2026-09-01T00:00:00Z");
const at = (iso) => new Date(iso);

const wave = (overrides = {}) => ({
    kind: "notice",
    status: "pending",
    scheduledAt: at("2026-08-31T00:00:00Z"),
    eventId: null,
    triggerMode: "approved_schedule",
    ...overrides,
});

test("a due wave on an approved schedule may start", () => {
    assert.equal(scheduleRefusal(wave(), NOW), null);
});

test("a manual campaign is never started for its operator", () => {
    // Somebody who left this on manual intends to watch it go out. Starting it
    // for them because a time happened to be set takes that decision away
    // without saying so.
    for (const triggerMode of ["manual", "auto_draft"]) {
        assert.equal(
            scheduleRefusal(wave({ triggerMode }), NOW).refusal,
            "manual_trigger_mode",
            triggerMode
        );
    }
});

test("a wave with no time is started by hand", () => {
    assert.equal(
        scheduleRefusal(wave({ scheduledAt: null }), NOW).refusal,
        "not_scheduled"
    );
});

test("a wave due later is left alone", () => {
    assert.equal(
        scheduleRefusal(wave({ scheduledAt: at("2026-09-02T00:00:00Z") }), NOW)
            .refusal,
        "not_due"
    );
});

test("a wave due at exactly now is due", () => {
    assert.equal(scheduleRefusal(wave({ scheduledAt: NOW }), NOW), null);
});

test("a wave that already began is refused rather than skipped silently", () => {
    // A scheduler that passed over started waves without a word would look
    // identical to one that had stopped finding them.
    assert.equal(
        scheduleRefusal(wave({ eventId: "evt_1" }), NOW).refusal,
        "already_started"
    );
    assert.equal(
        scheduleRefusal(wave({ status: "expanded" }), NOW).refusal,
        "already_started"
    );
});

test("the refusal says which one it is, because the fixes differ", () => {
    // `not_due` is nothing to do. `manual_trigger_mode` is a setting somebody
    // has to change. Collapsing them into "skipped" hides the second.
    assert.match(
        scheduleRefusal(wave({ triggerMode: "manual" }), NOW).message,
        /approved_schedule/
    );
    assert.match(
        scheduleRefusal(wave({ scheduledAt: at("2026-09-02T00:00:00Z") }), NOW)
            .message,
        /still ahead/
    );
});

const plan = (waves, overrides = {}) =>
    scheduleProblems({
        waves,
        now: NOW,
        effectiveAt: at("2026-09-15T00:00:00Z"),
        ...overrides,
    });

test("a sensible schedule has no problems", () => {
    assert.deepEqual(
        plan([
            { kind: "notice", scheduledAt: at("2026-09-01T00:00:00Z") },
            { kind: "reminder", scheduledAt: at("2026-09-12T00:00:00Z") },
            { kind: "completion", scheduledAt: at("2026-09-16T00:00:00Z") },
        ]),
        []
    );
});

test("a reminder before its notice reaches nobody", () => {
    // Not a mistake that sorts itself out at send time: the reminder
    // recomputes its audience from the people the notice already reached, and
    // sent first there are none.
    const problems = plan([
        { kind: "notice", scheduledAt: at("2026-09-12T00:00:00Z") },
        { kind: "reminder", scheduledAt: at("2026-09-02T00:00:00Z") },
    ]);
    assert.deepEqual(
        problems.map((problem) => problem.code),
        ["out_of_order"]
    );
    assert.match(problems[0].message, /reaches nobody/);
});

test("the ordering check survives a caller that sorted by time", () => {
    // The bug this exists for. `campaignScheduleProblems` reads the waves out
    // of the database ordered by scheduledAt, which is the natural way to list
    // a schedule -- and comparing consecutive entries of an already-ascending
    // list finds nothing, ever. The question is whether the notice precedes the
    // reminder, not whether the array is sorted.
    const problems = plan([
        { kind: "reminder", scheduledAt: at("2026-09-02T00:00:00Z") },
        { kind: "notice", scheduledAt: at("2026-09-12T00:00:00Z") },
    ]);
    assert.deepEqual(
        problems.map((problem) => problem.code),
        ["out_of_order"]
    );
});

test("a time in the past would send on approval, not when intended", () => {
    const problems = plan([
        { kind: "notice", scheduledAt: at("2026-08-01T00:00:00Z") },
    ]);
    assert.deepEqual(
        problems.map((problem) => problem.code),
        ["in_the_past"]
    );
});

test("a warning that arrives after the change is not a warning", () => {
    const problems = plan([
        { kind: "notice", scheduledAt: at("2026-09-20T00:00:00Z") },
    ]);
    assert.ok(problems.some((problem) => problem.code === "after_effective_at"));
});

test("the completion notice is the one that belongs after the date", () => {
    // It reports a change that has happened, so being late is what it is for.
    assert.deepEqual(
        plan([{ kind: "completion", scheduledAt: at("2026-09-16T00:00:00Z") }]),
        []
    );
});

test("no effective date means nothing to be late for", () => {
    assert.deepEqual(
        plan([{ kind: "notice", scheduledAt: at("2026-09-20T00:00:00Z") }], {
            effectiveAt: null,
        }),
        []
    );
});

test("the same kind twice is an editing mistake, not a repeat", () => {
    // Repeats are what sequence numbers are for; the unique index carries them.
    const problems = plan([
        { kind: "reminder", scheduledAt: at("2026-09-10T00:00:00Z") },
        { kind: "reminder", scheduledAt: at("2026-09-12T00:00:00Z") },
    ]);
    assert.deepEqual(
        problems.map((problem) => problem.code),
        ["duplicate_kind"]
    );
});

test("an unscheduled wave in the set is not a problem", () => {
    // A wave an operator will start by hand sits alongside scheduled ones.
    assert.deepEqual(
        plan([
            { kind: "notice", scheduledAt: null },
            { kind: "reminder", scheduledAt: at("2026-09-12T00:00:00Z") },
        ]),
        []
    );
});

test("the trigger modes are a closed list", () => {
    assert.deepEqual([...TRIGGER_MODES], [
        "manual",
        "auto_draft",
        "approved_schedule",
    ]);
    assert.equal(isTriggerMode("approved_schedule"), true);
    assert.equal(isTriggerMode("whenever"), false);
});
