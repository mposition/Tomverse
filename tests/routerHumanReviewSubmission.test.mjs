/**
 * A submission is read strictly because a person's sheet is not a model's
 * reply: a line holding two verdict words is not a verdict, and guessing which
 * one was meant would put the reader's preference into the measurement.
 *
 * These also fix the boundary the whole design rests on -- nothing knows which
 * side was Auto until `resolveToArms` applies the key -- and the rule that a
 * reserve is never spent by a module.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { bundle, ROUTABLE_MODEL_IDS } from "./routerHumanReviewFixture.mjs";
import { drawPrimarySample } from "../lib/routerHumanReviewSample.ts";
import { buildReviewPackage, renderSheetMarkdown } from "../lib/routerHumanReviewSheet.ts";
import {
    HUMAN_SUBMISSION_VERSION,
    parseSubmissionMarkdown,
    readSheetVerdict,
    resolveToArms,
    structuralFailures,
    submissionProblems,
    unreviewablePairs,
    verdictDistribution,
} from "../lib/routerHumanReviewSubmission.ts";

const REVIEWERS = ["reviewer-a", "reviewer-b"];

const pack = (source = bundle()) =>
    buildReviewPackage({
        manifest: drawPrimarySample({
            bundle: source,
            seed: 20260827,
            drawnAt: "2026-08-27T06:00:00Z",
            drawnBy: "mposition",
        }),
        bundle: source,
        reviewerIds: REVIEWERS,
        builtAt: "2026-08-27T07:00:00Z",
        builtBy: "mposition",
        routableModelIds: ROUTABLE_MODEL_IDS,
    });

const filledIn = (sheet, answerFor) =>
    renderSheetMarkdown(sheet)
        .split("\n")
        .map((line) => {
            const match = /^`([0-9a-f]{12})`: _+$/.exec(line);
            if (!match) return line;
            const answer = answerFor(match[1]);
            return answer === null ? line : `\`${match[1]}\`: ${answer}`;
        })
        .join("\n");

const parse = (text, sheet) =>
    parseSubmissionMarkdown({
        text,
        reviewerId: sheet.reviewerId,
        populationDigest: sheet.populationDigest,
        submittedAt: "2026-08-28T09:00:00Z",
    });

test("exactly one verdict word is a verdict, and nothing else is", () => {
    assert.deepEqual(readSheetVerdict("FIRST"), { verdict: "first" });
    assert.deepEqual(readSheetVerdict("  second  "), { verdict: "second" });
    assert.deepEqual(readSheetVerdict("Equivalent."), { verdict: "equivalent" });
    assert.ok("problem" in readSheetVerdict("not FIRST but SECOND"));
    assert.ok("problem" in readSheetVerdict("FIRST or maybe EQUIVALENT"));
    assert.ok("problem" in readSheetVerdict("hard to say"));
    assert.ok("problem" in readSheetVerdict(""));
});

test("a completed sheet reads back as one verdict per item", () => {
    const built = pack();
    const sheet = built.sheets[0];
    const text = filledIn(sheet, () => "FIRST");
    const { submission, unreadable } = parse(text, sheet);
    assert.equal(submission.submissionVersion, HUMAN_SUBMISSION_VERSION);
    assert.equal(submission.verdicts.length, 60);
    assert.deepEqual(unreadable, []);
    assert.deepEqual(submissionProblems(submission, sheet), []);
    assert.deepEqual(structuralFailures(submission, sheet, unreadable), []);
});

test("a blank sheet is 60 missing outputs, not 60 parse failures", () => {
    const built = pack();
    const sheet = built.sheets[0];
    const { submission, unreadable } = parse(renderSheetMarkdown(sheet), sheet);
    assert.equal(submission.verdicts.length, 0);
    assert.deepEqual(unreadable, []);
    const failures = structuralFailures(submission, sheet, unreadable);
    assert.equal(failures.length, 60);
    assert.ok(failures.every((failure) => failure.reason === "missing_output"));
});

test("an unreadable answer is a parse failure on that item alone", () => {
    const built = pack();
    const sheet = built.sheets[0];
    const target = sheet.items[3].itemId;
    const text = filledIn(sheet, (itemId) => (itemId === target ? "FIRST, though SECOND is close" : "SECOND"));
    const { submission, unreadable } = parse(text, sheet);
    assert.equal(submission.verdicts.length, 59);
    assert.equal(unreadable.length, 1);
    assert.equal(unreadable[0].itemId, target);
    const failures = structuralFailures(submission, sheet, unreadable);
    assert.deepEqual(failures.map((failure) => [failure.itemId, failure.reason]), [[target, "parse_failure"]]);
});

test("a submission against the wrong sheet or the wrong population is refused", () => {
    const built = pack();
    const [first, second] = built.sheets;
    const { submission } = parse(filledIn(first, () => "FIRST"), first);

    assert.ok(
        submissionProblems(submission, second).some((problem) => problem.includes("sheet")),
        "a sheet swap must be caught"
    );
    assert.ok(
        submissionProblems({ ...submission, populationDigest: "sha256:other" }, first).some((problem) =>
            problem.includes("different population")
        )
    );
    assert.ok(
        submissionProblems(
            { ...submission, verdicts: [...submission.verdicts, { itemId: "ffffffffffff", verdict: "first" }] },
            first
        ).some((problem) => problem.includes("never on this sheet"))
    );
});

test("the same item answered twice is caught rather than counted twice", () => {
    const built = pack();
    const sheet = built.sheets[0];
    const target = sheet.items[0].itemId;
    const text = `${filledIn(sheet, () => "FIRST")}\n\`${target}\`: SECOND\n`;
    const { unreadable } = parse(text, sheet);
    assert.ok(unreadable.some((entry) => entry.itemId === target && entry.detail.includes("twice")));
});

test("nothing knows which side was Auto until the key is applied", () => {
    const source = bundle();
    const built = pack(source);
    const sheet = built.sheets[0];
    const { submission } = parse(filledIn(sheet, () => "FIRST"), sheet);

    // The submission itself is positional, top to bottom.
    for (const entry of submission.verdicts) assert.equal(entry.verdict, "first");

    const resolved = resolveToArms(submission, built.key);
    assert.equal(resolved.length, 60);
    // The fixture puts Auto first on every pair, so "FIRST" resolves to auto.
    assert.ok(resolved.every((entry) => entry.verdict === "auto"));

    const byPairId = new Map(source.entries.map((entry) => [entry.pairId, entry]));
    for (const entry of resolved) assert.equal(byPairId.get(entry.pairId).first.arm, "auto");
});

test("SECOND resolves to whichever arm the bundle put second, not to a fixed label", () => {
    const source = bundle();
    const flipped = source.entries[0];
    [flipped.first, flipped.second] = [
        { ...flipped.second, arm: "baseline" },
        { ...flipped.first, arm: "auto" },
    ];
    const built = pack(source);
    const sheet = built.sheets[0];
    const { submission } = parse(filledIn(sheet, () => "SECOND"), sheet);
    const resolved = resolveToArms(submission, built.key);
    const rows = new Map(built.key.filter((row) => row.reviewerId === sheet.reviewerId).map((row) => [row.pairId, row]));
    for (const entry of resolved) assert.equal(entry.verdict, rows.get(entry.pairId).bArm);
});

test("one reviewer skipping an item is not a pair to replace", () => {
    const built = pack();
    const [first, second] = built.sheets;
    const skipped = first.items[0].itemId;
    const left = parse(filledIn(first, (itemId) => (itemId === skipped ? null : "FIRST")), first);
    const right = parse(filledIn(second, () => "SECOND"), second);

    const failures = [
        ...structuralFailures(left.submission, first, left.unreadable),
        ...structuralFailures(right.submission, second, right.unreadable),
    ];
    assert.equal(failures.length, 1);
    assert.deepEqual(unreviewablePairs(failures, built.key, REVIEWERS), []);
});

test("a pair every reviewer left ungradable is a candidate, not a substitution", () => {
    const built = pack();
    const [first, second] = built.sheets;
    const pairId = built.key.find((row) => row.reviewerId === first.reviewerId && row.itemId === first.items[0].itemId).pairId;
    const otherItemId = built.key.find((row) => row.reviewerId === second.reviewerId && row.pairId === pairId).itemId;

    const left = parse(filledIn(first, (itemId) => (itemId === first.items[0].itemId ? null : "FIRST")), first);
    const right = parse(filledIn(second, (itemId) => (itemId === otherItemId ? null : "SECOND")), second);
    const failures = [
        ...structuralFailures(left.submission, first, left.unreadable),
        ...structuralFailures(right.submission, second, right.unreadable),
    ];

    const candidates = unreviewablePairs(failures, built.key, REVIEWERS);
    assert.deepEqual(candidates.map((candidate) => candidate.pairId), [pairId]);
    assert.equal(candidates[0].reason, "missing_output");
    assert.ok(candidates[0].detail.includes("reviewer-a"));
    assert.ok(candidates[0].detail.includes("reviewer-b"));
});

test("the verdict spread is reported, never enforced", () => {
    const built = pack();
    const sheet = built.sheets[0];
    const { submission } = parse(filledIn(sheet, () => "EQUIVALENT"), sheet);
    assert.deepEqual(verdictDistribution(submission.verdicts), { first: 0, second: 0, equivalent: 60 });
    assert.deepEqual(submissionProblems(submission, sheet), []);
    assert.deepEqual(structuralFailures(submission, sheet, []), []);
});
