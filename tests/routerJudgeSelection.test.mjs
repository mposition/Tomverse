/**
 * The words that decide the outcome are numbers, frozen before any human label
 * is read.
 *
 * "Tie" and "far" are what the selection turns on, so a rule that leaves them
 * as prose is a rule that gets settled after the data arrives.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
    JUDGE_MARGIN_TOLERANCE_PP,
    JUDGE_OPPOSITE_VERDICT_CEILING,
    selectJudge,
} from "../lib/routerJudgeSelection.ts";

const judge = (judgeId, over = {}) => ({
    judgeId,
    marginShiftPp: over.marginShiftPp ?? 4,
    marginErrorPp: over.marginErrorPp ?? Math.abs(over.marginShiftPp ?? 4),
    exactAgreement: over.exactAgreement ?? 0.72,
    oppositeVerdictRate: over.oppositeVerdictRate ?? 0.03,
});

const input = (over = {}) => ({
    luna: over.luna ?? judge("luna", { marginShiftPp: 14 }),
    fable: over.fable ?? judge("fable", { marginShiftPp: 4 }),
    marginErrorDifferenceCi: over.marginErrorDifferenceCi ?? { lowerPp: 4, upperPp: 16 },
    humanPairs: over.humanPairs ?? 60,
});

test("the thresholds are the pre-registered ones", () => {
    assert.equal(JUDGE_MARGIN_TOLERANCE_PP, 10);
    assert.equal(JUDGE_OPPOSITE_VERDICT_CEILING, 0.1);
});

test("a judge measurably closer, and close enough, is preferred", () => {
    const result = selectJudge(input());
    assert.equal(result.outcome, "preferred");
    assert.equal(result.judgeId, "fable");
    assert.match(result.reasons[0], /excludes zero/);
});

test("an interval containing zero is a tie, and a tie is not broken by agreement", () => {
    // Fable has the better point estimate AND better exact agreement. Neither
    // decides: a rule that falls through whenever the first criterion is
    // inconclusive is a rule that always decides.
    const result = selectJudge(
        input({
            luna: judge("luna", { marginShiftPp: 6, exactAgreement: 0.6 }),
            fable: judge("fable", { marginShiftPp: 4, exactAgreement: 0.8 }),
            marginErrorDifferenceCi: { lowerPp: -3, upperPp: 7 },
        })
    );
    assert.equal(result.outcome, "undecided");
    assert.equal(result.judgeId, null);
    assert.match(result.reasons[0], /contains zero/);
    assert.match(result.reasons[1], /not a decision on exact agreement/);
});

test("the sign of the interval picks the judge", () => {
    // Negative throughout: D_luna - D_fable < 0, so Luna is closer.
    const result = selectJudge(
        input({
            luna: judge("luna", { marginShiftPp: 3 }),
            fable: judge("fable", { marginShiftPp: 12 }),
            marginErrorDifferenceCi: { lowerPp: -14, upperPp: -4 },
        })
    );
    assert.equal(result.outcome, "preferred");
    assert.equal(result.judgeId, "luna");
});

test("both judges beyond tolerance ends it, however clearly they differ", () => {
    const result = selectJudge(
        input({
            luna: judge("luna", { marginShiftPp: 30 }),
            fable: judge("fable", { marginShiftPp: 15 }),
            marginErrorDifferenceCi: { lowerPp: 8, upperPp: 22 },
        })
    );
    assert.equal(result.outcome, "undecided");
    assert.match(result.reasons.at(-2), /and so does luna/);
    assert.match(result.reasons.at(-2), /neither is a judge this comparison can vouch for/);
    assert.match(result.reasons.at(-1), /not the closer of two distant judges/);
});

test("being the closer of two is not being close enough", () => {
    // The tolerance is applied to the judge that would be adopted, so this and
    // the "both far" case are one check rather than two -- if the closer one
    // is beyond tolerance, so is the further one.
    const result = selectJudge(
        input({
            luna: judge("luna", { marginShiftPp: 40 }),
            fable: judge("fable", { marginShiftPp: 13 }),
            marginErrorDifferenceCi: { lowerPp: 18, upperPp: 36 },
        })
    );
    assert.equal(result.outcome, "undecided");
    assert.match(result.reasons.at(-2), /misses the human margin by \+13\.00pp, over the 10pp tolerance/);
});

test("reversals against people are a rail a good margin cannot buy past", () => {
    const result = selectJudge(
        input({ fable: judge("fable", { marginShiftPp: 1, oppositeVerdictRate: 0.15 }) })
    );
    assert.equal(result.outcome, "undecided");
    assert.match(result.reasons.at(-1), /reverses 15\.0% of pairs/);
    assert.match(result.reasons.at(-1), /will not cancel on another sample/);
});

test("a margin that cancels two reversals is still two reversals", () => {
    // Margin error 0 -- the errors offset exactly -- and the rail still holds.
    const result = selectJudge(
        input({ fable: judge("fable", { marginShiftPp: 0, oppositeVerdictRate: 0.2 }) })
    );
    assert.equal(result.outcome, "undecided");
});

test("no outcome activates the sample size, and every one carries the caveat", () => {
    // 60 pairs resolve to about +-10pp; ROUTE-01 decides at -2pp. Nothing this
    // function returns can license that leap.
    for (const result of [
        selectJudge(input()),
        selectJudge(input({ marginErrorDifferenceCi: { lowerPp: -2, upperPp: 9 } })),
        selectJudge(input({ fable: judge("fable", { marginShiftPp: 22 }) })),
    ]) {
        assert.equal(result.activatesSampleSize, false);
        assert.match(result.resolutionCaveat, /-2pp decision boundary/);
        assert.notEqual(result.outcome, "accepted");
    }
});
