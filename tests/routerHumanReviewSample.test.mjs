/**
 * The human sample calibrates the model judges, so it has to be drawn without
 * reference to what those judges said, and its size and shape have to be the
 * ones agreed rather than the ones a draw happened to produce.
 *
 * mposition's contract: 60 primary (4 per cell across 15 cells), 2 reserve per
 * cell in a fixed order, 2 reviewers per pair, adjudication on disagreement,
 * and a reserve spent only when a pair cannot be reviewed at all.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { bundle, side } from "./routerHumanReviewFixture.mjs";
import {
    ADJUDICATE_ON_DISAGREEMENT,
    HUMAN_PRIMARY_PER_CELL,
    HUMAN_RESERVE_PER_CELL,
    HUMAN_REVIEWERS_PER_PAIR,
    canonicalPopulationDigest,
    drawPrimarySample,
    effectiveSample,
    manifestProblems,
    redrawProblems,
    substitutionProblems,
    withSubstitution,
} from "../lib/routerHumanReviewSample.ts";

const draw = (seed = 20260827, source = bundle()) =>
    drawPrimarySample({ bundle: source, seed, drawnAt: "2026-08-27T06:00:00Z", drawnBy: "mposition" });

test("the draw is 60 primary and 30 reserve, four and two per cell", () => {
    const manifest = draw();
    assert.equal(manifest.cells.length, 15);
    assert.equal(manifest.cells.reduce((sum, cell) => sum + cell.primary.length, 0), 60);
    assert.equal(manifest.cells.reduce((sum, cell) => sum + cell.reserve.length, 0), 30);
    for (const cell of manifest.cells) {
        assert.equal(cell.primary.length, HUMAN_PRIMARY_PER_CELL);
        assert.equal(cell.reserve.length, HUMAN_RESERVE_PER_CELL);
    }
    assert.equal(manifest.reviewersPerPair, HUMAN_REVIEWERS_PER_PAIR);
    assert.equal(manifest.adjudicateOnDisagreement, ADJUDICATE_ON_DISAGREEMENT);
    assert.deepEqual(manifestProblems(manifest, bundle()), []);
});

test("primary and reserve never overlap", () => {
    const manifest = draw();
    for (const cell of manifest.cells) {
        for (const pairId of cell.reserve) {
            assert.ok(!cell.primary.includes(pairId), `${pairId} is both primary and reserve`);
        }
    }
    const all = manifest.cells.flatMap((cell) => [...cell.primary, ...cell.reserve]);
    assert.equal(new Set(all).size, all.length, "a pair was drawn twice");
});

// The language split falls out of the equal draw: 28 ko, 28 en, 4 ko-en.
test("the draw covers both languages without weighting", () => {
    const manifest = draw();
    const count = (suffix) =>
        manifest.cells
            .filter((cell) => cell.cell.endsWith(`/${suffix}`))
            .reduce((sum, cell) => sum + cell.primary.length, 0);
    assert.equal(count("ko"), 28);
    assert.equal(count("en"), 28);
    assert.equal(count("ko-en"), 4);
});

test("the same population and seed give the same draw", () => {
    assert.deepEqual(draw(20260827).cells, draw(20260827).cells);
    assert.notDeepEqual(draw(20260827).cells, draw(11111).cells);
});

// A bundle written twice can differ in line order. The draw must not.
test("the bundle's line order does not reach the draw", () => {
    const shuffledBundle = bundle();
    shuffledBundle.entries = [...shuffledBundle.entries].reverse();
    assert.equal(canonicalPopulationDigest(shuffledBundle), canonicalPopulationDigest(bundle()));
    assert.deepEqual(draw(20260827, shuffledBundle).cells, draw(20260827).cells);
});

// The point of the module boundary: there is no parameter a verdict could
// arrive through, so drawing on the strength of one is not a mistake a caller
// can make.
test("the draw takes no verdict, judge or score", () => {
    assert.equal(drawPrimarySample.length, 1);
    const [parameter] = /\(([^)]*)\)/.exec(drawPrimarySample.toString()) ?? [];
    assert.doesNotMatch(String(parameter), /verdict|judge|score|winner/i);
});

test("a manifest drawn from another population is caught", () => {
    const manifest = draw();
    const other = bundle();
    other.entries[0].first = side("auto", "a different answer");
    assert.match(
        manifestProblems(manifest, other).join(" "),
        /drawn from a different population/
    );
});

test("a manifest with the wrong per-cell numbers is caught", () => {
    const manifest = draw();
    const short = { ...manifest, cells: manifest.cells.map((cell, index) =>
        index === 0 ? { ...cell, primary: cell.primary.slice(0, 3) } : cell) };
    assert.match(manifestProblems(short).join(" "), /holds 3 primary pair\(s\), not 4/);

    const wrongContract = { ...manifest, reviewersPerPair: 1 };
    assert.match(manifestProblems(wrongContract).join(" "), /reviewersPerPair is 1, not 2/);

    const noAdjudication = { ...manifest, adjudicateOnDisagreement: false };
    assert.match(manifestProblems(noAdjudication).join(" "), /would stand unresolved/);
});

// --- substitutions ---------------------------------------------------------

const structural = (manifest, cellIndex = 0) => {
    const cell = manifest.cells[cellIndex];
    return {
        pairId: cell.primary[0],
        replacedBy: cell.reserve[0],
        reason: "parse_failure",
        detail: "the submitted sheet had no verdict for this pair",
        at: "2026-08-27T07:00:00Z",
        by: "mposition",
    };
};

test("a structural failure may spend the next reserve", () => {
    const manifest = draw();
    const substitution = structural(manifest);
    assert.deepEqual(substitutionProblems(manifest, substitution), []);
    const after = withSubstitution(manifest, substitution);
    const sample = effectiveSample(after);
    assert.equal(sample.length, 60);
    assert.ok(!sample.includes(substitution.pairId));
    assert.ok(sample.includes(substitution.replacedBy));
});

// The rule the whole contract turns on: a sample that drops the pairs whose
// answers came out a particular way is no longer a random sample of anything.
test("a verdict is never a reason to replace a pair", () => {
    const manifest = draw();
    for (const reason of ["judges_disagreed", "auto_lost", "tie", "equivalent"]) {
        const problems = substitutionProblems(manifest, { ...structural(manifest), reason });
        assert.match(problems.join(" "), /is not a structural reason/, `${reason} should be refused`);
    }
});

test("the reserve is spent in the order fixed at the draw", () => {
    const manifest = draw();
    const cell = manifest.cells[0];
    const outOfOrder = { ...structural(manifest), replacedBy: cell.reserve[1] };
    assert.match(
        substitutionProblems(manifest, outOfOrder).join(" "),
        /must spend .* next, .*: the reserve order was fixed at the draw/
    );
});

test("a pair is replaced once, and only from its own cell's reserve", () => {
    const manifest = draw();
    const first = structural(manifest);
    const after = withSubstitution(manifest, first);
    assert.match(substitutionProblems(after, first).join(" "), /has already been replaced/);

    const foreign = { ...structural(manifest), replacedBy: manifest.cells[1].reserve[0] };
    assert.match(substitutionProblems(manifest, foreign).join(" "), /must spend .* next/);

    const notPrimary = { ...structural(manifest), pairId: manifest.cells[0].reserve[1] };
    assert.match(substitutionProblems(manifest, notPrimary).join(" "), /is not a primary pair/);
});

test("a substitution must say who, when and why in detail", () => {
    const manifest = draw();
    for (const field of ["detail", "at", "by"]) {
        const incomplete = { ...structural(manifest), [field]: "" };
        assert.match(substitutionProblems(manifest, incomplete).join(" "), new RegExp(`has no ${field}`));
    }
});

// --- redrawing -------------------------------------------------------------

test("a second seed over the same population needs a stated reason", () => {
    const first = draw(20260827);
    const silent = draw(99999);
    assert.match(redrawProblems(first, silent).join(" "), /needs redrawOf naming the previous seed/);

    const declared = drawPrimarySample({
        bundle: bundle(),
        seed: 99999,
        drawnAt: "2026-08-28T06:00:00Z",
        drawnBy: "mposition",
        redrawOf: { populationDigest: first.populationDigest, previousSeed: 20260827, reason: "the first draw predated a corrected bundle" },
    });
    assert.deepEqual(redrawProblems(first, declared), []);
});

test("a redraw that names the wrong previous seed is caught", () => {
    const first = draw(20260827);
    const wrong = drawPrimarySample({
        bundle: bundle(),
        seed: 99999,
        drawnAt: "2026-08-28T06:00:00Z",
        drawnBy: "mposition",
        redrawOf: { populationDigest: first.populationDigest, previousSeed: 12345, reason: "x" },
    });
    assert.match(redrawProblems(first, wrong).join(" "), /redrawOf names seed 12345/);
});

test("a draw over a different population is not a redraw", () => {
    const first = draw(20260827);
    const other = bundle();
    other.entries[0].first = side("auto", "a different answer");
    assert.deepEqual(redrawProblems(first, draw(99999, other)), []);
});
