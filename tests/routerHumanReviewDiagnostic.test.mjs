/**
 * The diagnostic supplement is drawn on purpose from the pairs the two model
 * judges split on, which is the exact opposite of how the primary sample is
 * drawn -- and the reason the two can never be pooled into one rate.
 *
 * mposition's contract: at most two per cell, drawn only from outside the
 * primary sixty, and reported as counts rather than as a percentage that would
 * be read beside the primary one.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { bundle } from "./routerHumanReviewFixture.mjs";
import {
    DIAGNOSTIC_DISAGREEMENTS_PER_CELL,
    drawPrimarySample,
} from "../lib/routerHumanReviewSample.ts";
import {
    DIAGNOSTIC_DRAW_VERSION,
    diagnosticProblems,
    diagnosticReadout,
    diagnosticSample,
    drawDiagnosticSample,
    judgeDisagreements,
    primaryFootprint,
} from "../lib/routerHumanReviewDiagnostic.ts";

const SEED = 20260827;

const primaryOf = (source) =>
    drawPrimarySample({ bundle: source, seed: SEED, drawnAt: "2026-08-27T06:00:00Z", drawnBy: "mposition" });

const pass = (provider, apiModel, verdictFor, source) => ({
    identity: { modelId: apiModel, provider, apiModel },
    bundleDigest: "sha256:the-same-answers",
    verdicts: source.entries.map((entry) => ({ pairId: entry.pairId, verdict: verdictFor(entry.pairId) })),
});

/** Judges that split on every third pair, so every cell has something to draw. */
const splitOnEveryThird = (source) => {
    const disputed = new Set(source.entries.filter((entry, index) => index % 3 === 0).map((entry) => entry.pairId));
    return {
        disputed,
        target: pass("openai", "gpt-5.6-luna", () => "auto", source),
        reference: pass("anthropic", "claude-fable-5", (pairId) => (disputed.has(pairId) ? "baseline" : "auto"), source),
    };
};

const draw = (source, seed = 20260828) => {
    const { target, reference } = splitOnEveryThird(source);
    return drawDiagnosticSample({
        bundle: source,
        primary: primaryOf(source),
        target,
        reference,
        seed,
        drawnAt: "2026-08-29T06:00:00Z",
        drawnBy: "mposition",
    });
};

test("only pairs the two judges read differently are eligible", () => {
    const source = bundle();
    const { disputed, target, reference } = splitOnEveryThird(source);
    assert.deepEqual([...judgeDisagreements(target, reference)].sort(), [...disputed].sort());

    const supplement = draw(source);
    for (const pairId of diagnosticSample(supplement)) assert.ok(disputed.has(pairId));
});

test("nothing in the primary draw can be drawn again as a diagnostic", () => {
    const source = bundle();
    const primary = primaryOf(source);
    const supplement = draw(source);
    const spokenFor = primaryFootprint(primary);

    // The footprint is primary plus reserve, not just the sixty.
    assert.equal(spokenFor.size, 90);
    for (const pairId of diagnosticSample(supplement)) assert.ok(!spokenFor.has(pairId));
    assert.deepEqual(diagnosticProblems(supplement, primary), []);
});

test("an overlap with the primary sample is refused by name", () => {
    const source = bundle();
    const primary = primaryOf(source);
    const supplement = draw(source);
    const stolen = primary.cells[0].primary[0];
    const contaminated = {
        ...supplement,
        cells: supplement.cells.map((cell, index) =>
            index === 0 ? { ...cell, pairIds: [stolen] } : cell
        ),
    };
    const problems = diagnosticProblems(contaminated, primary);
    assert.ok(problems.some((problem) => problem.includes(stolen) && problem.includes("counted twice")));
});

test("at most two per cell, and a cell short of two says so", () => {
    const source = bundle();
    const supplement = draw(source);
    for (const cell of supplement.cells) {
        assert.ok(cell.pairIds.length <= DIAGNOSTIC_DISAGREEMENTS_PER_CELL);
        assert.ok(cell.pairIds.length <= cell.disagreementsAvailable);
    }

    // One cell where the judges split on a single pair, and that pair is
    // outside the primary draw.
    const thin = bundle();
    const primary = primaryOf(thin);
    const spokenFor = primaryFootprint(primary);
    const lonely = thin.entries.find(
        (entry) => entry.stratum === "coding" && entry.cell === "ko" && !spokenFor.has(entry.pairId)
    );
    const target = pass("openai", "gpt-5.6-luna", () => "auto", thin);
    const reference = pass(
        "anthropic",
        "claude-fable-5",
        (pairId) => (pairId === lonely.pairId ? "baseline" : "auto"),
        thin
    );
    const one = drawDiagnosticSample({
        bundle: thin,
        primary,
        target,
        reference,
        seed: 20260828,
        drawnAt: "2026-08-29T06:00:00Z",
        drawnBy: "mposition",
    });
    assert.deepEqual(diagnosticSample(one), [lonely.pairId]);
    const readout = diagnosticReadout(one);
    assert.equal(readout.length, 1);
    assert.deepEqual(readout[0], {
        cell: "coding/ko",
        drawn: 1,
        disagreementsAvailable: 1,
        shortOfTarget: 1,
    });
});

test("judges who never disagree produce an empty supplement, not a filled one", () => {
    const source = bundle();
    const agreeing = pass("openai", "gpt-5.6-luna", () => "auto", source);
    const alsoAgreeing = pass("anthropic", "claude-fable-5", () => "auto", source);
    const supplement = drawDiagnosticSample({
        bundle: source,
        primary: primaryOf(source),
        target: agreeing,
        reference: alsoAgreeing,
        seed: 20260828,
        drawnAt: "2026-08-29T06:00:00Z",
        drawnBy: "mposition",
    });
    assert.deepEqual(supplement.cells, []);
    assert.deepEqual(diagnosticSample(supplement), []);
});

test("two judge passes over different answers cannot produce a disagreement", () => {
    const source = bundle();
    const { target, reference } = splitOnEveryThird(source);
    assert.throws(
        () =>
            drawDiagnosticSample({
                bundle: source,
                primary: primaryOf(source),
                target,
                reference: { ...reference, bundleDigest: "sha256:other-answers" },
                seed: 20260828,
                drawnAt: "2026-08-29T06:00:00Z",
                drawnBy: "mposition",
            }),
        /different bundles/
    );
});

test("a bundle the primary was not drawn from is refused", () => {
    const source = bundle();
    const other = bundle(13);
    const { target, reference } = splitOnEveryThird(source);
    assert.throws(
        () =>
            drawDiagnosticSample({
                bundle: source,
                primary: primaryOf(other),
                target,
                reference,
                seed: 20260828,
                drawnAt: "2026-08-29T06:00:00Z",
                drawnBy: "mposition",
            }),
        /not the population the primary sample was drawn from/
    );
});

test("the same seed gives the same supplement, and a different one does not", () => {
    const source = bundle();
    assert.deepEqual(diagnosticSample(draw(source, 20260828)), diagnosticSample(draw(source, 20260828)));
    assert.notDeepEqual(diagnosticSample(draw(source, 20260828)), diagnosticSample(draw(source, 20260829)));
});

test("the supplement is a different type from the primary manifest, and says what it is for", () => {
    const source = bundle();
    const supplement = draw(source);
    assert.equal(supplement.drawVersion, DIAGNOSTIC_DRAW_VERSION);
    assert.equal(supplement.purpose, "diagnostic");
    // None of the fields the primary contract is checked against, so nothing
    // that takes a HumanSampleManifest can be handed this by accident.
    for (const field of ["manifestVersion", "perCell", "reviewersPerPair", "substitutions", "redrawOf"]) {
        assert.equal(supplement[field], undefined, `a diagnostic draw must not carry ${field}`);
    }
    assert.equal(supplement.primaryPopulationDigest, primaryOf(source).populationDigest);
    assert.equal(supplement.primarySeed, SEED);
});

test("a draw that calls itself something other than diagnostic is refused", () => {
    const source = bundle();
    const supplement = { ...draw(source), purpose: "primary" };
    const problems = diagnosticProblems(supplement, primaryOf(source));
    assert.ok(problems.some((problem) => problem.includes("only a diagnostic draw selects on verdicts")));
});
