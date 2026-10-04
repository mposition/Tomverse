/**
 * Two reviewers grade every pair; a third settles the ones they split on, and
 * settles them by grading rather than by choosing between two names.
 *
 * The properties worth pinning: the adjudicator's sheet cannot carry what the
 * reviewers said, a third opinion cannot reach a pair they agreed on, three
 * graders who all differ are recorded as undecided rather than broken apart,
 * and the reviewers' own agreement rate is computed before the third grader
 * exists.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { bundle, ROUTABLE_MODEL_IDS } from "./routerHumanReviewFixture.mjs";
import { drawPrimarySample, effectiveSample } from "../lib/routerHumanReviewSample.ts";
import { buildReviewPackage, renderSheetMarkdown } from "../lib/routerHumanReviewSheet.ts";
import { HUMAN_SUBMISSION_VERSION } from "../lib/routerHumanReviewSubmission.ts";
import {
    ADJUDICATION_VERSION,
    adjudicationProblems,
    buildAdjudicationSheet,
    collateVerdicts,
    pairsNeedingAdjudication,
    settleSample,
    settledArmVerdicts,
} from "../lib/routerHumanReviewAdjudication.ts";

const REVIEWERS = ["reviewer-a", "reviewer-b"];
const SEED = 20260827;

const setup = (source = bundle()) => {
    const manifest = drawPrimarySample({
        bundle: source,
        seed: SEED,
        drawnAt: "2026-08-27T06:00:00Z",
        drawnBy: "mposition",
    });
    const pack = buildReviewPackage({
        manifest,
        bundle: source,
        reviewerIds: REVIEWERS,
        builtAt: "2026-08-27T07:00:00Z",
        builtBy: "mposition",
        routableModelIds: ROUTABLE_MODEL_IDS,
    });
    return { source, manifest, pack, pairIds: effectiveSample(manifest) };
};

/** A submission built straight from the key, so the tests control every verdict. */
const submissionOf = (reviewerId, key, verdictFor, populationDigest) => ({
    submissionVersion: HUMAN_SUBMISSION_VERSION,
    reviewerId,
    populationDigest,
    submittedAt: "2026-08-28T09:00:00Z",
    verdicts: key
        .filter((row) => row.reviewerId === reviewerId)
        .map((row) => ({ itemId: row.itemId, verdict: verdictFor(row.pairId) }))
        .filter((entry) => entry.verdict !== null),
});

test("two reviewers who agree settle every pair without an adjudicator", () => {
    const { pack, manifest, pairIds } = setup();
    const submissions = REVIEWERS.map((reviewerId) =>
        submissionOf(reviewerId, pack.key, () => "first", manifest.populationDigest)
    );
    const settled = settleSample({
        submissions,
        key: pack.key,
        reviewerIds: REVIEWERS,
        pairIds,
        populationDigest: manifest.populationDigest,
        settledAt: "2026-08-28T10:00:00Z",
        settledBy: "mposition",
    });
    assert.equal(settled.adjudicationVersion, ADJUDICATION_VERSION);
    assert.equal(settled.counts.agreed, 60);
    assert.equal(settled.counts.needsAdjudication, 0);
    assert.equal(settled.reviewerAgreementRate, 1);
    assert.equal(settled.adjudicatorId, null);
});

test("the reviewers' agreement rate is measured before any third opinion", () => {
    const { pack, manifest, pairIds } = setup();
    const split = new Set(pairIds.slice(0, 12));
    const submissions = [
        submissionOf("reviewer-a", pack.key, () => "first", manifest.populationDigest),
        submissionOf(
            "reviewer-b",
            pack.key,
            (pairId) => (split.has(pairId) ? "second" : "first"),
            manifest.populationDigest
        ),
    ];
    const first = settleSample({
        submissions,
        key: pack.key,
        reviewerIds: REVIEWERS,
        pairIds,
        populationDigest: manifest.populationDigest,
        settledAt: "2026-08-28T10:00:00Z",
        settledBy: "mposition",
    });
    assert.equal(first.counts.needsAdjudication, 12);
    assert.equal(first.reviewerAgreementRate, 48 / 60);

    const adjudication = submissionOf(
        "reviewer-c",
        buildAdjudicationSheet({
            adjudicatorId: "reviewer-c",
            collated: first.pairs,
            bundle: bundle(),
            seed: SEED,
            populationDigest: manifest.populationDigest,
            reviewerIds: REVIEWERS,
        }).key,
        () => "first",
        manifest.populationDigest
    );
    const second = settleSample({
        submissions,
        adjudication,
        key: [
            ...pack.key,
            ...buildAdjudicationSheet({
                adjudicatorId: "reviewer-c",
                collated: first.pairs,
                bundle: bundle(),
                seed: SEED,
                populationDigest: manifest.populationDigest,
                reviewerIds: REVIEWERS,
            }).key,
        ],
        reviewerIds: REVIEWERS,
        pairIds,
        populationDigest: manifest.populationDigest,
        settledAt: "2026-08-28T11:00:00Z",
        settledBy: "mposition",
    });
    // The third opinion settles the split pairs and does not move the number
    // that describes how hard the two reviewers found the judgement.
    assert.equal(second.counts.adjudicated, 12);
    assert.equal(second.counts.agreed, 48);
    assert.equal(second.counts.needsAdjudication, 0);
    assert.equal(second.reviewerAgreementRate, 48 / 60);
});

test("the adjudicator's sheet holds the disputed pairs and nothing about the split", () => {
    const { pack, manifest, source, pairIds } = setup();
    const split = new Set(pairIds.slice(0, 5));
    const collated = collateVerdicts({
        submissions: [
            submissionOf("reviewer-a", pack.key, () => "first", manifest.populationDigest),
            submissionOf(
                "reviewer-b",
                pack.key,
                (pairId) => (split.has(pairId) ? "equivalent" : "first"),
                manifest.populationDigest
            ),
        ],
        key: pack.key,
        reviewerIds: REVIEWERS,
        pairIds,
    });
    assert.deepEqual([...pairsNeedingAdjudication(collated)].sort(), [...split].sort());

    const { sheet } = buildAdjudicationSheet({
        adjudicatorId: "reviewer-c",
        collated,
        bundle: source,
        seed: SEED,
        populationDigest: manifest.populationDigest,
        reviewerIds: REVIEWERS,
    });
    assert.equal(sheet.items.length, 5);
    const rendered = renderSheetMarkdown(sheet).toLowerCase();
    for (const marker of ["reviewer-a", "reviewer-b", "disagree", "split", "first said", "second said"]) {
        assert.ok(!rendered.includes(marker), `the adjudication sheet mentions ${marker}`);
    }
    // Different labels from either reviewer's, so a leaked sheet cannot be
    // lined up against a reviewer's by item number.
    const reviewerLabels = new Set(pack.key.map((row) => row.itemId));
    for (const item of sheet.items) assert.ok(!reviewerLabels.has(item.itemId));
});

test("a reviewer cannot adjudicate their own sample", () => {
    const { pack, manifest, source, pairIds } = setup();
    const collated = collateVerdicts({
        submissions: [
            submissionOf("reviewer-a", pack.key, () => "first", manifest.populationDigest),
            submissionOf("reviewer-b", pack.key, () => "second", manifest.populationDigest),
        ],
        key: pack.key,
        reviewerIds: REVIEWERS,
        pairIds,
    });
    assert.throws(
        () =>
            buildAdjudicationSheet({
                adjudicatorId: "reviewer-a",
                collated,
                bundle: source,
                seed: SEED,
                populationDigest: manifest.populationDigest,
                reviewerIds: REVIEWERS,
            }),
        /third opinion/
    );
});

test("an adjudication that reaches an agreed pair is refused", () => {
    const { pack, manifest, source, pairIds } = setup();
    const split = new Set(pairIds.slice(0, 3));
    const collated = collateVerdicts({
        submissions: [
            submissionOf("reviewer-a", pack.key, () => "first", manifest.populationDigest),
            submissionOf(
                "reviewer-b",
                pack.key,
                (pairId) => (split.has(pairId) ? "second" : "first"),
                manifest.populationDigest
            ),
        ],
        key: pack.key,
        reviewerIds: REVIEWERS,
        pairIds,
    });
    const built = buildAdjudicationSheet({
        adjudicatorId: "reviewer-c",
        collated,
        bundle: source,
        seed: SEED,
        populationDigest: manifest.populationDigest,
        reviewerIds: REVIEWERS,
    });
    const key = [...pack.key, ...built.key];

    assert.deepEqual(
        adjudicationProblems({
            collated,
            adjudication: submissionOf("reviewer-c", built.key, () => "first", manifest.populationDigest),
            key,
            reviewerIds: REVIEWERS,
        }),
        []
    );

    // A sheet drawn over the whole sample instead of the disputed three.
    const overreaching = buildAdjudicationSheet({
        adjudicatorId: "reviewer-c",
        collated: collated.map((pair) => ({ ...pair, status: "needs_adjudication" })),
        bundle: source,
        seed: SEED,
        populationDigest: manifest.populationDigest,
        reviewerIds: REVIEWERS,
    });
    const problems = adjudicationProblems({
        collated,
        adjudication: submissionOf("reviewer-c", overreaching.key, () => "first", manifest.populationDigest),
        key: [...pack.key, ...overreaching.key],
        reviewerIds: REVIEWERS,
    });
    assert.ok(problems.some((problem) => problem.includes("overturn an agreement")));

    assert.ok(
        adjudicationProblems({
            collated,
            adjudication: submissionOf("reviewer-a", built.key, () => "first", manifest.populationDigest),
            key,
            reviewerIds: REVIEWERS,
        }).some((problem) => problem.includes("not a third opinion"))
    );
});

test("three graders who all differ are recorded as undecided, not broken apart", () => {
    const { pack, manifest, source, pairIds } = setup();
    const contested = pairIds[0];
    const submissions = [
        submissionOf("reviewer-a", pack.key, (pairId) => (pairId === contested ? "first" : "first"), manifest.populationDigest),
        submissionOf(
            "reviewer-b",
            pack.key,
            (pairId) => (pairId === contested ? "second" : "first"),
            manifest.populationDigest
        ),
    ];
    const collated = collateVerdicts({ submissions, key: pack.key, reviewerIds: REVIEWERS, pairIds });
    const built = buildAdjudicationSheet({
        adjudicatorId: "reviewer-c",
        collated,
        bundle: source,
        seed: SEED,
        populationDigest: manifest.populationDigest,
        reviewerIds: REVIEWERS,
    });
    const settled = settleSample({
        submissions,
        adjudication: submissionOf("reviewer-c", built.key, () => "equivalent", manifest.populationDigest),
        key: [...pack.key, ...built.key],
        reviewerIds: REVIEWERS,
        pairIds,
        populationDigest: manifest.populationDigest,
        settledAt: "2026-08-28T11:00:00Z",
        settledBy: "mposition",
    });
    assert.equal(settled.counts.noConsensus, 1);
    assert.equal(settled.counts.agreed, 59);
    const undecided = settled.pairs.find((pair) => pair.pairId === contested);
    assert.equal(undecided.status, "no_consensus");
    assert.equal(undecided.verdict, undefined);
});

test("an undecided pair is left out of the arm verdicts, not counted as a tie", () => {
    const { pack, manifest, pairIds } = setup();
    const contested = pairIds[0];
    const submissions = [
        submissionOf("reviewer-a", pack.key, () => "first", manifest.populationDigest),
        submissionOf(
            "reviewer-b",
            pack.key,
            (pairId) => (pairId === contested ? "second" : "first"),
            manifest.populationDigest
        ),
    ];
    const settled = settleSample({
        submissions,
        key: pack.key,
        reviewerIds: REVIEWERS,
        pairIds,
        populationDigest: manifest.populationDigest,
        settledAt: "2026-08-28T10:00:00Z",
        settledBy: "mposition",
    });
    const arms = settledArmVerdicts(settled, pack.key);
    assert.equal(arms.length, 59);
    assert.ok(!arms.some((entry) => entry.pairId === contested));
    // The fixture puts Auto first, so a FIRST agreement is a win for Auto.
    assert.ok(arms.every((entry) => entry.verdict === "auto"));
});

test("a pair one reviewer never graded is incomplete, not a disagreement", () => {
    const { pack, manifest, pairIds } = setup();
    const skipped = pairIds[0];
    const submissions = [
        submissionOf("reviewer-a", pack.key, () => "first", manifest.populationDigest),
        submissionOf(
            "reviewer-b",
            pack.key,
            (pairId) => (pairId === skipped ? null : "first"),
            manifest.populationDigest
        ),
    ];
    const settled = settleSample({
        submissions,
        key: pack.key,
        reviewerIds: REVIEWERS,
        pairIds,
        populationDigest: manifest.populationDigest,
        settledAt: "2026-08-28T10:00:00Z",
        settledBy: "mposition",
    });
    assert.equal(settled.counts.incomplete, 1);
    assert.equal(settled.counts.needsAdjudication, 0);
    // An ungraded pair is not in the denominator of how often the two agreed.
    assert.equal(settled.reviewerAgreementRate, 1);
});

test("adjudicating nothing is an error, not an empty sheet to hand out", () => {
    const { pack, manifest, source, pairIds } = setup();
    const collated = collateVerdicts({
        submissions: REVIEWERS.map((reviewerId) =>
            submissionOf(reviewerId, pack.key, () => "first", manifest.populationDigest)
        ),
        key: pack.key,
        reviewerIds: REVIEWERS,
        pairIds,
    });
    assert.throws(
        () =>
            buildAdjudicationSheet({
                adjudicatorId: "reviewer-c",
                collated,
                bundle: source,
                seed: SEED,
                populationDigest: manifest.populationDigest,
                reviewerIds: REVIEWERS,
            }),
        /nothing to adjudicate/
    );
});
