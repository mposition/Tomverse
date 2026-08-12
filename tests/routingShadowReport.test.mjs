import assert from "node:assert/strict";
import test from "node:test";

import { buildShadowReport } from "../lib/routingShadowReport.ts";

/**
 * Reading shadow routing back.
 *
 * The failure this guards against is not an arithmetic slip; it is a number
 * that means something other than what a reader will take it to mean. An
 * agreement rate computed over rows where the Router had no answer, a rate of
 * zero printed for an empty group, or two rule versions pooled into one figure
 * are all wrong in that way — plausible, and about nothing.
 */

const row = (overrides = {}) => ({
    taskProfileVersion: "task-profile-v1",
    candidateFilterVersion: "router-candidates-v1",
    selectionVersion: "router-selection-v1",
    profileKind: "general",
    plan: "Free",
    selectedModelId: "a",
    selectionReason: "task_preference",
    userSelectedModelId: "a",
    eligibleCount: 3,
    rejectedByReason: {},
    decisionMicros: 500,
    ...overrides,
});

test("agreement counts only rows the Router actually decided", () => {
    // An undecided row is not a different choice; it is no choice. Counting it
    // as disagreement would make a Router that could not answer look like one
    // that answered differently.
    const report = buildShadowReport([
        row(),
        row({ selectedModelId: "b" }),
        row({ selectedModelId: null, selectionReason: "no_candidate" }),
    ]);
    assert.equal(report.rows, 3);
    assert.equal(report.decided, 2);
    assert.equal(report.undecided, 1);
    assert.equal(report.agreed, 1);
    assert.equal(report.agreementRate, 0.5);
});

test("an empty sample reports no rate rather than zero", () => {
    // Zero is a claim — "they never agree". The honest answer is that nothing
    // was compared.
    const empty = buildShadowReport([]);
    assert.equal(empty.rows, 0);
    assert.equal(empty.agreementRate, null);

    const allUndecided = buildShadowReport([row({ selectedModelId: null })]);
    assert.equal(allUndecided.decided, 0);
    assert.equal(allUndecided.agreementRate, null);
});

test("mixed rule versions are flagged rather than pooled", () => {
    // Two versions averaged into one rate describes neither of them.
    const same = buildShadowReport([row(), row()]);
    assert.equal(same.versions.mixed, false);

    const mixed = buildShadowReport([
        row(),
        row({ selectionVersion: "router-selection-v2" }),
    ]);
    assert.equal(mixed.versions.mixed, true);
    assert.deepEqual(mixed.versions.selectionVersions, [
        "router-selection-v1",
        "router-selection-v2",
    ]);
});

test("switches name both ends and are ranked by how often they happen", () => {
    const report = buildShadowReport([
        row({ userSelectedModelId: "luna", selectedModelId: "deep" }),
        row({ userSelectedModelId: "luna", selectedModelId: "deep" }),
        row({ userSelectedModelId: "luna", selectedModelId: "sonar" }),
        row({ userSelectedModelId: "luna", selectedModelId: "luna" }),
    ]);
    assert.deepEqual(report.switches, [
        { from: "luna", to: "deep", count: 2 },
        { from: "luna", to: "sonar", count: 1 },
    ]);
});

test("the switch list is capped and stable", () => {
    // Two runs over the same data must print the same order, or a diff between
    // two reports is noise.
    const rows = ["b", "c", "d"].map((to) =>
        row({ userSelectedModelId: "a", selectedModelId: to })
    );
    const first = buildShadowReport(rows, { maxSwitches: 2 });
    assert.equal(first.switches.length, 2);
    assert.deepEqual(first.switches, buildShadowReport([...rows].reverse(), {
        maxSwitches: 2,
    }).switches);
});

test("groups exclude undecided rows from their own denominators too", () => {
    const report = buildShadowReport([
        row({ profileKind: "coding", selectedModelId: "a" }),
        row({ profileKind: "coding", selectedModelId: "b" }),
        row({ profileKind: "coding", selectedModelId: null }),
        row({ profileKind: "writing", selectedModelId: "a" }),
    ]);
    const coding = report.byTaskKind.find((group) => group.key === "coding");
    assert.equal(coding.decided, 2);
    assert.equal(coding.agreementRate, 0.5);
    // Busiest group first, so the number a reader sees first is the one with
    // the most behind it.
    assert.equal(report.byTaskKind[0].key, "coding");
});

test("plans are grouped the same way", () => {
    const report = buildShadowReport([
        row({ plan: "Guest", selectedModelId: "b" }),
        row({ plan: "Pro" }),
    ]);
    assert.deepEqual(
        report.byPlan.map((group) => [group.key, group.agreementRate]).sort(),
        [
            ["Guest", 0],
            ["Pro", 1],
        ]
    );
});

test("rejection reasons are summed across rows, not counted once each", () => {
    // Each row refuses several models; what a reader wants is how many models
    // each filter turned away, not how many rows mentioned it.
    const report = buildShadowReport([
        row({ rejectedByReason: { plan: 3, context_exceeded: 1 } }),
        row({ rejectedByReason: { plan: 2 } }),
    ]);
    assert.deepEqual(report.rejectionReasons, { plan: 5, context_exceeded: 1 });
});

test("selection reasons are counted per row", () => {
    const report = buildShadowReport([
        row({ selectionReason: "sticky" }),
        row({ selectionReason: "sticky" }),
        row({ selectionReason: "only_candidate" }),
    ]);
    assert.deepEqual(report.selectionReasons, {
        sticky: 2,
        only_candidate: 1,
    });
});

test("a row with no rejection map does not break the totals", () => {
    const report = buildShadowReport([
        row({ rejectedByReason: undefined }),
        row({ rejectedByReason: { plan: 1 } }),
    ]);
    assert.deepEqual(report.rejectionReasons, { plan: 1 });
});

test("latency percentiles report a value some decision really had", () => {
    const report = buildShadowReport(
        [100, 200, 300, 400, 500].map((micros) => row({ decisionMicros: micros }))
    );
    assert.equal(report.decisionMicrosP50, 300);
    assert.equal(report.decisionMicrosP95, 500);
});

test("undecided rows still count towards latency and reasons", () => {
    // The Router spent time deciding it had nothing, and that time is part of
    // what ROUTE-02 bounds.
    const report = buildShadowReport([
        row({ selectedModelId: null, selectionReason: "no_candidate", decisionMicros: 900 }),
    ]);
    assert.equal(report.decisionMicrosP50, 900);
    assert.deepEqual(report.selectionReasons, { no_candidate: 1 });
});

// The ceiling on how much traffic Auto could serve even if every choice it
// made were perfect. Easy to skip past as a restatement of "decided", and more
// consequential than the agreement rate it sits beside.
test("candidate availability is measured over every row, not over the decided ones", () => {
    const report = buildShadowReport([
        row({ selectedModelId: "a", eligibleCount: 3 }),
        row({ selectedModelId: "b", eligibleCount: 2 }),
        row({ selectedModelId: null, selectionReason: "no_candidate", eligibleCount: 0 }),
        row({ selectedModelId: null, selectionReason: "no_candidate", eligibleCount: 0 }),
    ]);

    // Two of four rows had somewhere to go. Dividing by the decided rows would
    // answer 100% every time and say nothing.
    assert.equal(report.candidateAvailabilityRate, 0.5);
    assert.equal(report.eligibleCountP50, 0);
    assert.equal(report.eligibleCountP95, 3);
});

test("candidate availability is null rather than zero when nothing was observed", () => {
    assert.equal(buildShadowReport([]).candidateAvailabilityRate, null);
    assert.equal(buildShadowReport([]).stickyHeldRate, null);
});

// A Router collapsing onto one model shows up here and nowhere else: the
// switch pairs would look busy while every arrow pointed at one destination.
test("the destination distribution shows where Auto would land", () => {
    const report = buildShadowReport([
        row({ selectedModelId: "winner", userSelectedModelId: "a" }),
        row({ selectedModelId: "winner", userSelectedModelId: "b" }),
        row({ selectedModelId: "winner", userSelectedModelId: "winner" }),
        row({ selectedModelId: "other", userSelectedModelId: "c" }),
        row({ selectedModelId: null, selectionReason: "no_candidate" }),
    ]);

    // Counts every decided row, including the ones where the Router agreed --
    // a model the Router keeps choosing is the point, whether or not the user
    // had already chosen it.
    assert.deepEqual(report.selectedModelCounts, { winner: 3, other: 1 });
});

test("the sticky-held rate is over decided turns, and counts only held ones", () => {
    const report = buildShadowReport([
        row({ selectedModelId: "a", selectionReason: "sticky" }),
        row({ selectedModelId: "a", selectionReason: "sticky" }),
        row({ selectedModelId: "b", selectionReason: "task_preference" }),
        row({ selectedModelId: "b", selectionReason: "only_candidate" }),
        row({ selectedModelId: null, selectionReason: "no_candidate" }),
    ]);

    assert.equal(report.stickyHeldRate, 0.5);
    assert.equal(report.decided, 4);
});
