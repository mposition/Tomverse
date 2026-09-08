// The distinctions the scoring contract has to make.
//
// These are requirements, not a record of behaviour. Each one states an
// outcome the evaluation needs in order to mean anything, and the keyword
// scorer in `aiReviewEvalCore` gets four of them wrong -- see
// `tests/aiReviewEvalScoringContract.test.mjs`, which pins that gap on
// purpose.
//
// The worked example is the v9 003 candidate: the gold is "c never gives the
// two-week objection deadline", declared exhaustive.

import assert from "node:assert/strict";
import test from "node:test";

import {
    AI_REVIEW_SCORING_CONTRACT_VERSION,
    scoreJudgedCase,
} from "../lib/aiReviewEvalJudgement.ts";

const DEADLINE = "objection_deadline";

const judgedCase = (overrides = {}) => ({
    caseId: "ko-safety-sensitive-003",
    contractVersion: AI_REVIEW_SCORING_CONTRACT_VERSION,
    gold: { missingPoints: [{ requirementId: DEADLINE, targetLabel: "c" }] },
    goldCompleteness: { missingPoints: true },
    ...overrides,
});

const claim = (overrides = {}) => ({
    targetLabel: "c",
    requirementId: DEADLINE,
    assertion: "missing",
    speechAct: "finding",
    submittedAs: "missingPoints",
    sourceIndex: 0,
    evidenceQuote: "c는 기한을 제시하지 않는다",
    status: "confirmed",
    confirmedBy: "operator",
    confirmedAt: "2026-09-08T00:00:00.000Z",
    ...overrides,
});

const counts = (outcome) => {
    assert.equal(outcome.scored, true, outcome.reason);
    const kind = outcome.byKind.missingPoints;
    return [kind.truePositives, kind.falseNegatives, kind.falsePositives];
};

test("a correct finding scores, and the wording it used does not matter", () => {
    // The synonym problem disappears rather than being solved: the record
    // names a requirement id, so "2주" and "14일" are the same claim and the
    // scorer never sees either string.
    assert.deepEqual(counts(scoreJudgedCase(judgedCase(), [claim()])), [1, 0, 0]);
    assert.deepEqual(
        counts(
            scoreJudgedCase(judgedCase(), [
                claim({ evidenceQuote: "c는 14일 기한을 말하지 않는다" }),
            ])
        ),
        [1, 0, 0]
    );
});

test("accusing the wrong answer is a miss AND a wrong finding", () => {
    // The keyword scorer gives this a true positive. It is the single most
    // damaging thing it does: a reviewer that names any answer at all scores
    // as well as one that read them.
    assert.deepEqual(
        counts(scoreJudgedCase(judgedCase(), [claim({ targetLabel: "a" })])),
        [0, 1, 1]
    );
});

test("asserting the element is present is a miss AND a wrong finding", () => {
    // Submitted into `missingPoints` while saying nothing is missing. The gold
    // item goes unfound, and what was filed is a finding the gold does not
    // contain.
    assert.deepEqual(
        counts(
            scoreJudgedCase(judgedCase(), [
                claim({
                    assertion: "present",
                    evidenceQuote: "c에는 기한이 명시되어 있어 누락이 없다",
                }),
            ])
        ),
        [0, 1, 1]
    );
    // `unclear` is not a report of the omission either.
    assert.deepEqual(
        counts(scoreJudgedCase(judgedCase(), [claim({ assertion: "unclear" })])),
        [0, 1, 1]
    );
});

test("reporting nothing is a miss and nothing else", () => {
    // A reviewer that stays silent has missed the finding. It has not made a
    // wrong one, and scoring it as though it had would punish silence more
    // than error.
    assert.deepEqual(counts(scoreJudgedCase(judgedCase(), [])), [0, 1, 0]);
});

test("the same words outside a findings field are not a report", () => {
    // A quotation of the answer, a hypothetical, and a passing mention in the
    // reviewer's prose. None is a finding, so none scores -- and none is a
    // wrong finding either, because nothing was put forward.
    for (const claimed of [
        claim({ submittedAs: "prose", sourceIndex: null, speechAct: "quotation" }),
        claim({ submittedAs: "prose", sourceIndex: null, speechAct: "hypothetical" }),
        claim({ submittedAs: "prose", sourceIndex: null, speechAct: "mention" }),
    ]) {
        assert.deepEqual(
            counts(scoreJudgedCase(judgedCase(), [claimed])),
            [0, 1, 0],
            claimed.speechAct
        );
    }
});

test("a quotation filed AS a finding is a wrong finding", () => {
    // The other half of the rule. What lands in a findings field was put
    // forward as one, whatever its content -- so an item that is only a quote
    // is an improper submission rather than a free pass.
    assert.deepEqual(
        counts(
            scoreJudgedCase(judgedCase(), [
                claim({ speechAct: "quotation", assertion: "present" }),
            ])
        ),
        [0, 1, 1]
    );
});

test("repeating a true finding does not earn a second hit", () => {
    // And is not punished as a wrong one: saying a right thing twice is
    // neither two findings nor a mistake. It is counted separately so that
    // padding is visible.
    const outcome = scoreJudgedCase(judgedCase(), [claim(), claim({ sourceIndex: 1 })]);
    assert.deepEqual(counts(outcome), [1, 0, 0]);
    assert.equal(outcome.byKind.missingPoints.duplicates, 1);
});

test("wrong findings are counted only where the gold claims to be complete", () => {
    // An incomplete gold cannot tell an extra finding from one it forgot, so
    // it does not get to call anything a false positive. The miss still counts:
    // a gold item that went unreported went unreported either way.
    assert.deepEqual(
        counts(
            scoreJudgedCase(
                judgedCase({ goldCompleteness: { missingPoints: false } }),
                [claim({ targetLabel: "a" })]
            )
        ),
        [0, 1, 0]
    );
});

test("a claim nobody confirmed stops the case being scored at all", () => {
    // Not scored as zero, not scored with the claim dropped. A structured
    // field is the extractor's declaration; `gold.accusedLabel` had to be
    // renamed for exactly this reason, and a number computed over unread text
    // would repeat that mistake with more decimal places.
    const outcome = scoreJudgedCase(judgedCase(), [
        claim(),
        claim({ status: "pending", confirmedBy: null, confirmedAt: null }),
    ]);
    assert.equal(outcome.scored, false);
    assert.match(outcome.reason, /nobody has confirmed/);
    assert.equal(outcome.byKind, undefined);
});

test("a record written for another contract is refused, not converted", () => {
    const outcome = scoreJudgedCase(
        judgedCase({ contractVersion: "ai-review-scoring-judged-v0" }),
        [claim()]
    );
    assert.equal(outcome.scored, false);
    assert.match(outcome.reason, /do not\s+carry across contracts/);
});

test("a claim about a requirement the gold never names is refused", () => {
    // Not a false positive: it means the record and the case disagree about
    // what the case is. A total over that disagreement is about neither.
    const outcome = scoreJudgedCase(judgedCase(), [
        claim({ requirementId: "call_emergency_services" }),
    ]);
    assert.equal(outcome.scored, false);
    assert.match(outcome.reason, /call_emergency_services/);
});

test("two gold items are matched independently", () => {
    // The units have to be separable, or a reviewer reporting one of two
    // bundled actions scores the same as one reporting both -- which is the
    // gold-atomicity failure this evaluation keeps finding in its own data.
    const twoItems = judgedCase({
        gold: {
            missingPoints: [
                { requirementId: DEADLINE, targetLabel: "c" },
                { requirementId: "evidence_preservation", targetLabel: "c" },
            ],
        },
    });
    assert.deepEqual(counts(scoreJudgedCase(twoItems, [claim()])), [1, 1, 0]);
    assert.deepEqual(
        counts(
            scoreJudgedCase(twoItems, [
                claim(),
                claim({ requirementId: "evidence_preservation", sourceIndex: 1 }),
            ])
        ),
        [2, 0, 0]
    );
});

test("a finding of the wrong KIND does not satisfy a gold item", () => {
    // `missingPoints` and `contradictions` are different questions. Reporting
    // an omission as a contradiction is a finding the gold does not contain.
    assert.deepEqual(
        counts(scoreJudgedCase(judgedCase(), [claim({ submittedAs: "contradictions" })])),
        [0, 1, 0]
    );
    const contradictions = scoreJudgedCase(judgedCase(), [
        claim({ submittedAs: "contradictions" }),
    ]);
    assert.equal(contradictions.byKind.contradictions.falsePositives, 0);
});
