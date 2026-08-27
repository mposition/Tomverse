/**
 * The gate in front of the expensive judge. mposition's floors: 200 of 210
 * overall, 13 of 14 in every cell, and no bundle problems at all.
 *
 * The per-cell floor is not decoration. A bundle can sit above the overall
 * floor and still be missing most of one stratum, and a calibration computed
 * over it is a calibration on a set where that stratum barely appears.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { bundle, CELLS } from "./routerHumanReviewFixture.mjs";
import { answerBundleProblems } from "../lib/routerAnswerBundle.ts";
import {
    CELL_PAIRED_COVERAGE_FLOOR,
    PAIRED_COVERAGE_FLOOR,
    bundleCoverage,
    bundleCoverageProblems,
} from "../lib/routerBundleCoverage.ts";

const planned = Object.fromEntries(CELLS.map(([stratum, cell]) => [`${stratum}/${cell}`, 14]));

/** Remove the first `count` entries that match, by id, so the count is exact. */
const drop = (source, count, matches = () => true) => {
    const doomed = new Set(
        source.entries.filter(matches).slice(0, count).map((entry) => entry.pairId)
    );
    return { ...source, entries: source.entries.filter((entry) => !doomed.has(entry.pairId)) };
};

test("mposition's floors are the ones the gate applies", () => {
    assert.deepEqual(PAIRED_COVERAGE_FLOOR, { covered: 200, planned: 210 });
    assert.deepEqual(CELL_PAIRED_COVERAGE_FLOOR, { covered: 13, planned: 14 });
});

test("a complete bundle passes", () => {
    const coverage = bundleCoverage(bundle(), planned);
    assert.equal(coverage.covered, 210);
    assert.equal(coverage.planned, 210);
    assert.deepEqual(bundleCoverageProblems(coverage), []);
});

test("ten missing pairs is the edge, eleven is refused", () => {
    // 200/210 is the floor, so exactly 200 passes. Spread across cells so the
    // per-cell floor is not what fires.
    const evenly = (entry, index) => index % 15 === 0;
    const atFloor = drop(bundle(), 10, evenly);
    assert.equal(atFloor.entries.length, 200);
    assert.deepEqual(bundleCoverageProblems(bundleCoverage(atFloor, planned)), []);

    const under = drop(bundle(), 11, evenly);
    assert.equal(under.entries.length, 199);
    assert.match(
        bundleCoverageProblems(bundleCoverage(under, planned)).join(" "),
        /holds 199 of 210 planned pair\(s\), under the 200\/210 floor/
    );
});

test("a bundle above the overall floor still fails on a hollowed-out cell", () => {
    // Nine of coding/en removed: 201 of 210 overall, which clears 200, and
    // coding/en at 5 of 14, which does not clear 13.
    const hollow = drop(
        bundle(),
        9,
        (entry) => entry.stratum === "coding" && entry.cell === "en"
    );
    assert.equal(hollow.entries.length, 201);
    const problems = bundleCoverageProblems(bundleCoverage(hollow, planned));
    assert.equal(problems.length, 1);
    assert.match(problems[0], /coding\/en holds 5 of 14, under the 13\/14 floor/);
});

test("a pair in a cell the run never planned is caught", () => {
    const source = bundle();
    source.entries.push({ ...source.entries[0], pairId: "surprise-1", stratum: "unplanned", cell: "ko" });
    assert.match(
        bundleCoverageProblems(bundleCoverage(source, planned)).join(" "),
        /unplanned\/ko holds 1 pair\(s\) the run never planned/
    );
});

test("the writer and the reader agree about what counts as an answer", () => {
    // The one that cost a 91-minute run: the pilot wrote `result.text ?? ""`
    // and answerBundleProblems demanded non-empty, so a bundle full of empty
    // slots passed the writer and was refused by the reader.
    const empty = bundle(1);
    empty.entries[0].first.text = "   \n ";
    assert.match(
        answerBundleProblems(empty).join(" "),
        /has no text a person could read/
    );

    const fine = bundle(1);
    assert.deepEqual(
        answerBundleProblems(fine).filter((p) => /text a person could read/.test(p)),
        []
    );
});
