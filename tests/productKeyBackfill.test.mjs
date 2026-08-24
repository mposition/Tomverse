import { strict as assert } from "node:assert";
import test from "node:test";

import {
    backfillPlanFingerprint,
    findBackfillApprovalProblems,
    planProductKeyBackfill,
    verifyProductKeyBackfill,
} from "../lib/productKeyBackfillCore.ts";

/**
 * Decision record v1.2 §2 — the backfill order and the gate in the middle.
 *
 * The gate is the whole design: an unclassified row has no safe default in
 * either direction, so the plan has to refuse rather than pick one.
 */

const row = (id, overrides = {}) => ({
    id,
    kind: "chat",
    selectionMode: "manual",
    productKey: null,
    ...overrides,
});

const plan = (rows, classifications = []) =>
    planProductKeyBackfill({ rows, classifications });

const codes = (problems) => problems.map((problem) => problem.code);

/* ------------------------------------------------------- steps 1 and 3 */

test("selectionMode='auto' rows are extracted, never classified", () => {
    // Decision 3 has just established that selectionMode cannot imply a
    // product. Using it as a classification rule here would contradict the
    // same document two sections later.
    const result = plan([row("a", { selectionMode: "auto" }), row("b")]);

    assert.deepEqual(result.extracted.map((r) => r.id), ["a"]);
    assert.deepEqual(result.toReview.map((r) => r.id), ["b"]);
    assert.ok(!result.toReview.some((r) => r.id === "a"));
    assert.ok(!result.toStudio.some((r) => r.id === "a"));
});

test("one unclassified row blocks the whole backfill", () => {
    const result = plan([row("a", { selectionMode: "auto" }), row("b")]);

    assert.deepEqual(result.unclassified.map((r) => r.id), ["a"]);
    assert.deepEqual(codes(result.blockers), ["unclassified_rows"]);
});

test("an unclassified row is never quietly relabelled review", () => {
    // Relabelling destroys the only evidence of what it was, and nothing can
    // undo it afterwards.
    const result = plan([row("a", { selectionMode: "auto" })]);
    assert.deepEqual(result.toReview, []);
    assert.deepEqual(result.toStudio, []);
});

test("an image conversation marked auto is still extracted, not sent to studio", () => {
    // Routing it on kind alone would relabel the exact row this step exists to
    // stop and look at.
    const result = plan([row("a", { kind: "image", selectionMode: "auto" })]);
    assert.deepEqual(result.extracted.map((r) => r.id), ["a"]);
    assert.deepEqual(result.toStudio, []);
});

test("classifying every extracted row clears the block", () => {
    const result = plan(
        [row("a", { selectionMode: "auto" }), row("b")],
        [{ conversationId: "a", productKey: "chat", evidence: "drill log 2026-08-14" }]
    );

    assert.deepEqual(result.unclassified, []);
    assert.deepEqual(result.blockers, []);
    assert.deepEqual(result.classified.map(({ row: r }) => r.id), ["a"]);
});

test("a classification that contradicts the row's modality is a blocker", () => {
    const result = plan(
        [row("a", { kind: "image", selectionMode: "auto" })],
        [{ conversationId: "a", productKey: "chat", evidence: "drill log" }]
    );

    assert.ok(codes(result.blockers).includes("classification_conflicts_modality"));
});

/* ------------------------------------------------------- steps 4 and 5 */

test("image rows go to studio and everything else to review", () => {
    const result = plan([
        row("img", { kind: "image" }),
        row("chat1"),
        row("chat2"),
    ]);

    assert.deepEqual(result.toStudio.map((r) => r.id), ["img"]);
    assert.deepEqual(result.toReview.map((r) => r.id), ["chat1", "chat2"]);
});

test("rows that already carry a product are left alone", () => {
    const result = plan([
        row("set", { productKey: "review" }),
        row("unset"),
    ]);

    assert.deepEqual(result.alreadySet.map((r) => r.id), ["set"]);
    assert.deepEqual(result.toReview.map((r) => r.id), ["unset"]);
});

test("the expected shape on a clean database is a no-op", () => {
    // The column defaults to manual and the Auto toggle has never been
    // mounted, so zero extracted rows is what production should report -- but
    // that is an expectation, which is why the report runs rather than being
    // reasoned about.
    const result = plan([]);
    assert.deepEqual(result.extracted, []);
    assert.deepEqual(result.blockers, []);
});

/* ---------------------------------------------------------- step 6 */

test("verification needs all three, not just the NULL count", () => {
    // A verification that reported only NULL = 0 would pass on a run that
    // relabelled an unresolved exception.
    assert.equal(
        verifyProductKeyBackfill({
            nullCount: 0,
            unclassifiedCount: 0,
            drillConversations: [{ id: "a", productKey: "chat" }],
        }).passed,
        true
    );

    assert.equal(
        verifyProductKeyBackfill({
            nullCount: 1,
            unclassifiedCount: 0,
            drillConversations: [],
        }).passed,
        false
    );
    assert.equal(
        verifyProductKeyBackfill({
            nullCount: 0,
            unclassifiedCount: 1,
            drillConversations: [],
        }).passed,
        false
    );

    const drifted = verifyProductKeyBackfill({
        nullCount: 0,
        unclassifiedCount: 0,
        drillConversations: [{ id: "a", productKey: "review" }],
    });
    assert.equal(drifted.passed, false);
    assert.deepEqual(drifted.drillRowsNotChat, ["a"]);
});

/* ------------------------------------------------------------ write gate */

const approval = (overrides = {}) => ({
    apply: true,
    approvedBackfill: true,
    ticket: "https://tickets.example/TV-1",
    actor: "operator",
    dryRunReportPath: "report.json",
    dryRunReportDigest: "digest",
    environment: { ci: false, automatedHook: null },
    ...overrides,
});

const problems = (overrides = {}, planOverride = plan([row("b")])) =>
    findBackfillApprovalProblems({
        approval: approval(overrides),
        plan: planOverride,
        currentReportDigest: "digest",
    });

test("a dry run is always allowed and never checked", () => {
    assert.deepEqual(
        findBackfillApprovalProblems({
            approval: approval({
                apply: false,
                approvedBackfill: false,
                ticket: null,
                actor: null,
                dryRunReportPath: null,
                dryRunReportDigest: null,
                environment: { ci: true, automatedHook: "build" },
            }),
            plan: plan([row("a", { selectionMode: "auto" })]),
            currentReportDigest: "digest",
        }),
        []
    );
});

test("a complete approval over a clean plan may write", () => {
    assert.deepEqual(problems(), []);
});

test("each missing part of the approval line is named", () => {
    assert.deepEqual(codes(problems({ approvedBackfill: false })), [
        "missing_approval_flag",
    ]);
    assert.deepEqual(codes(problems({ ticket: null })), ["missing_ticket"]);
    assert.deepEqual(codes(problems({ actor: null })), ["missing_actor"]);
    assert.deepEqual(codes(problems({ dryRunReportPath: null })), [
        "missing_dry_run_report",
    ]);
});

test("a dry-run report describing different rows is refused", () => {
    // The data moved since the report was reviewed, so the review does not
    // cover what would be written.
    assert.deepEqual(codes(problems({ dryRunReportDigest: "stale" })), [
        "dry_run_report_mismatch",
    ]);
});

test("CI and npm lifecycle steps can never write", () => {
    assert.deepEqual(codes(problems({ environment: { ci: true, automatedHook: null } })), [
        "automated_context",
    ]);
    assert.deepEqual(
        codes(problems({ environment: { ci: false, automatedHook: "build" } })),
        ["automated_context"]
    );
});

test("a plan blocker is not something an approval can sign away", () => {
    const blocked = plan([row("a", { selectionMode: "auto" })]);
    assert.ok(codes(problems({}, blocked)).includes("plan_blocked"));
});

/* ----------------------------------------------------------- fingerprint */

test("the fingerprint is stable across row order and carries no content", () => {
    const forward = plan([row("a"), row("b", { kind: "image" })]);
    const reversed = plan([row("b", { kind: "image" }), row("a")]);

    assert.equal(backfillPlanFingerprint(forward), backfillPlanFingerprint(reversed));
    assert.ok(!backfillPlanFingerprint(forward).includes("title"));
});

test("the fingerprint changes when the plan would write something different", () => {
    assert.notEqual(
        backfillPlanFingerprint(plan([row("a")])),
        backfillPlanFingerprint(plan([row("a"), row("b")]))
    );
});
