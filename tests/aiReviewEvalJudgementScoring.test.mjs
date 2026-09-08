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
    validateJudgedCase,
    verifyJudgementRecord,
} from "../lib/aiReviewEvalJudgement.ts";

const DEADLINE = "objection_deadline";

const judgedCase = (overrides = {}) => ({
    caseId: "ko-safety-sensitive-003",
    contractVersion: AI_REVIEW_SCORING_CONTRACT_VERSION,
    sourceCaseDigest: "sha256:the-question-and-answers-a-person-read",
    responseLabels: ["a", "b", "c"],
    requirements: [
        { id: DEADLINE, description: "송달일부터 2주 이내 이의신청 기한" },
        { id: "evidence_preservation", description: "변제 입증 자료 보존" },
        { id: "transport_mode", description: "이송 수단" },
    ],
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

const record = (claims, overrides = {}) => ({
    caseId: "ko-safety-sensitive-003",
    contractVersion: AI_REVIEW_SCORING_CONTRACT_VERSION,
    observationRef: "run-1/attempt-1",
    reviewedBy: "operator",
    reviewedAt: "2026-09-08T00:00:00.000Z",
    claims,
    ...overrides,
});

const score = (testCase, claims, recordOverrides = {}) =>
    scoreJudgedCase(testCase, record(claims, recordOverrides));

const counts = (outcome) => {
    assert.equal(outcome.scored, true, outcome.reason);
    const kind = outcome.byKind.missingPoints;
    return [kind.truePositives, kind.falseNegatives, kind.falsePositives];
};

// ---------------------------------------------------------------------------
// The four axes
// ---------------------------------------------------------------------------

test("a correct finding scores, and the wording it used does not matter", () => {
    // The synonym judgement moves rather than disappearing: a person decided
    // that "2주" and "14일" are one requirement, and from then on the scorer
    // never sees either string.
    assert.deepEqual(counts(score(judgedCase(), [claim()])), [1, 0, 0]);
    assert.deepEqual(
        counts(
            score(judgedCase(), [claim({ evidenceQuote: "c는 14일 기한을 말하지 않는다" })])
        ),
        [1, 0, 0]
    );
});

test("accusing the wrong answer is a miss AND a wrong finding, once ruled", () => {
    // The keyword scorer gives this a true positive. It is the single most
    // damaging thing it does: a reviewer that names any answer at all scores
    // as well as one that read them.
    //
    // But it takes a person to say so. "c omits the deadline" is not evidence
    // that `a` gives it, so this claim is outside the gold and carries the
    // same verdict as any other claim outside it.
    assert.deepEqual(
        counts(
            score(judgedCase(), [
                claim({ targetLabel: "a", outsideGoldVerdict: "false_finding" }),
            ])
        ),
        [0, 1, 1]
    );
});

test("the same requirement in another answer can be a gold gap", () => {
    // The contract contradicted itself here: it offered a route for reporting
    // an incomplete gold, then keyed the gold's scope by requirement id alone
    // and threw that verdict away for the shape such findings most often take.
    // `a` may genuinely omit the deadline too.
    const outcome = score(
        judgedCase({ goldCompleteness: { missingPoints: false } }),
        [claim(), claim({ targetLabel: "a", sourceIndex: 1, outsideGoldVerdict: "gold_incomplete" })]
    );
    assert.deepEqual(counts(outcome), [1, 0, 0]);
    assert.equal(outcome.byKind.missingPoints.goldGaps, 1);

    // And with no verdict it is undetermined, not a wrong finding.
    const unruled = score(judgedCase(), [claim(), claim({ targetLabel: "a", sourceIndex: 1 })]);
    assert.equal(unruled.scored, false);
    assert.match(unruled.reason, /a objection_deadline/);
});

test("asserting the element is present is a miss AND a wrong finding", () => {
    assert.deepEqual(
        counts(
            score(judgedCase(), [
                claim({
                    assertion: "present",
                    evidenceQuote: "c에는 기한이 명시되어 있어 누락이 없다",
                }),
            ])
        ),
        [0, 1, 1]
    );
    assert.deepEqual(counts(score(judgedCase(), [claim({ assertion: "unclear" })])), [0, 1, 1]);
});

test("reporting nothing is a miss and nothing else", () => {
    assert.deepEqual(counts(score(judgedCase(), [])), [0, 1, 0]);
});

test("the same words outside a findings field are not a report", () => {
    for (const claimed of [
        claim({ submittedAs: "prose", sourceIndex: null, speechAct: "quotation" }),
        claim({ submittedAs: "prose", sourceIndex: null, speechAct: "hypothetical" }),
        claim({ submittedAs: "prose", sourceIndex: null, speechAct: "mention" }),
    ]) {
        assert.deepEqual(counts(score(judgedCase(), [claimed])), [0, 1, 0], claimed.speechAct);
    }
});

test("a quotation filed AS a finding is a wrong finding", () => {
    assert.deepEqual(
        counts(score(judgedCase(), [claim({ speechAct: "quotation", assertion: "present" })])),
        [0, 1, 1]
    );
});

test("repeating a true finding does not earn a second hit", () => {
    const outcome = score(judgedCase(), [claim(), claim({ sourceIndex: 1 })]);
    assert.deepEqual(counts(outcome), [1, 0, 0]);
    assert.equal(outcome.byKind.missingPoints.duplicates, 1);
});

test("two gold items are matched independently", () => {
    const twoItems = judgedCase({
        gold: {
            missingPoints: [
                { requirementId: DEADLINE, targetLabel: "c" },
                { requirementId: "evidence_preservation", targetLabel: "c" },
            ],
        },
    });
    assert.deepEqual(counts(score(twoItems, [claim()])), [1, 1, 0]);
    assert.deepEqual(
        counts(
            score(twoItems, [
                claim(),
                claim({ requirementId: "evidence_preservation", sourceIndex: 1 }),
            ])
        ),
        [2, 0, 0]
    );
});

test("a finding of the wrong KIND does not satisfy a gold item", () => {
    // The gold's scope is per kind, so an omission filed under contradictions
    // is outside it and takes a verdict like anything else outside it.
    const outcome = score(judgedCase(), [
        claim({ submittedAs: "contradictions", outsideGoldVerdict: "false_finding" }),
    ]);
    assert.deepEqual(counts(outcome), [0, 1, 0]);
    // And it is not a false positive against a `contradictions` gold that
    // never claimed to be exhaustive.
    assert.equal(outcome.byKind.contradictions.falsePositives, 0);
    assert.equal(outcome.byKind.contradictions.precisionCounted, false);
});

// ---------------------------------------------------------------------------
// Findings the gold does not contain
//
// A gold lists what SHOULD be reported. It is not a list of everything a
// reviewer might say, so a claim outside it is not a record error -- inventing
// a problem that is not there is one of the things this evaluation measures.
// ---------------------------------------------------------------------------

test("an invented finding is a wrong finding, even when the gold is empty", () => {
    // The case with nothing to report -- genuine_consensus, no_issue -- exists
    // precisely to measure this, and a contract that cannot score it is blind
    // to half of what it was built for.
    const nothingToFind = judgedCase({
        gold: { missingPoints: [] },
        goldCompleteness: { missingPoints: true },
    });
    const outcome = score(nothingToFind, [
        claim({
            requirementId: "invented_requirement",
            outsideGoldVerdict: "false_finding",
        }),
    ]);
    assert.deepEqual(counts(outcome), [0, 0, 1]);
});

test("a correct finding and an invented one are scored together", () => {
    const outcome = score(judgedCase(), [
        claim(),
        claim({
            requirementId: "invented_requirement",
            sourceIndex: 1,
            outsideGoldVerdict: "false_finding",
        }),
    ]);
    assert.deepEqual(counts(outcome), [1, 0, 1]);
});

test("a finding the gold forgot is reported as a gap, not held against the reviewer", () => {
    // The reviewer was right. That is a fact about the CASE -- its gold is
    // short an item -- and scoring it as a mistake would punish the one thing
    // an evaluation most needs to hear.
    const outcome = score(judgedCase({ goldCompleteness: { missingPoints: false } }), [
        claim(),
        claim({
            requirementId: "reignition_guard",
            sourceIndex: 1,
            outsideGoldVerdict: "gold_incomplete",
        }),
    ]);
    assert.deepEqual(counts(outcome), [1, 0, 0]);
    assert.equal(outcome.byKind.missingPoints.goldGaps, 1);
});

test("an exhaustive gold a confirmed gap disproved is not scored, and the gap survives", () => {
    // Both cannot stand. Leaving the numbers valid beside the gap would report
    // a precision denominator counted against a list now known to be short,
    // and a recall denominator that WAS that short list.
    const outcome = score(judgedCase(), [
        claim(),
        claim({
            requirementId: "reignition_guard",
            sourceIndex: 1,
            outsideGoldVerdict: "gold_incomplete",
        }),
    ]);
    assert.equal(outcome.scored, false);
    assert.equal(outcome.byKind, undefined);
    assert.match(outcome.reason, /missingPoints gold is declared exhaustive/);
    // The diagnosis is what the case has to be corrected with, so it survives.
    assert.equal(outcome.goldGaps.missingPoints, 1);
    // And correcting it means re-scoring everyone, not excluding the finder.
    assert.match(outcome.reason, /re-score EVERY reviewer/);
});

test("a confirmed gold gap survives a refusal caused by something else", () => {
    // The gap count used to be computed after the undetermined refusal, so one
    // unrelated unruled claim swallowed it. The operator was told to go and
    // rule on something and never told that a gold defect had already been
    // confirmed -- and with it, that every reviewer on this case needs
    // re-scoring. A refusal is a report, so it reports what is known.
    const outcome = score(judgedCase(), [
        claim(),
        claim({
            requirementId: "reignition_guard",
            sourceIndex: 1,
            outsideGoldVerdict: "gold_incomplete",
        }),
        claim({ requirementId: "something_else", sourceIndex: 2 }),
    ]);
    assert.equal(outcome.scored, false);
    assert.equal(outcome.goldGaps.missingPoints, 1);
    // Both reasons, not the first one to fire.
    assert.match(outcome.reason, /something_else/);
    assert.match(outcome.reason, /missingPoints gold is declared exhaustive/);
    assert.match(outcome.reason, /re-score EVERY reviewer/);
});

test("the refusal stops the whole case, not the kind that caused it", () => {
    // A reviewer's score is read across kinds, and half of one is not a
    // smaller score -- it is a different measurement wearing the same name.
    const twoKinds = judgedCase({
        gold: {
            missingPoints: [{ requirementId: DEADLINE, targetLabel: "c" }],
            contradictions: [{ requirementId: "transport_mode", targetLabel: "b" }],
        },
        goldCompleteness: { missingPoints: true, contradictions: true },
    });
    const outcome = score(twoKinds, [
        claim(),
        claim({
            submittedAs: "contradictions",
            requirementId: "transport_mode",
            targetLabel: "b",
            sourceIndex: 0,
        }),
        claim({
            requirementId: "reignition_guard",
            sourceIndex: 1,
            outsideGoldVerdict: "gold_incomplete",
        }),
    ]);
    assert.equal(outcome.scored, false);
    assert.equal(outcome.byKind, undefined, "no kind is scored, including the sound one");
    assert.match(outcome.reason, /is not scored/);
});

test("an unruled finding outside the gold stops the case being scored", () => {
    // The only thing that should stay undetermined here: nobody has said
    // whether the reviewer invented it or the gold forgot it.
    for (const verdict of [undefined, "undetermined"]) {
        const outcome = score(judgedCase(), [
            claim({ requirementId: "unknown_requirement", outsideGoldVerdict: verdict }),
        ]);
        assert.equal(outcome.scored, false, String(verdict));
        assert.match(outcome.reason, /unknown_requirement/);
        assert.equal(outcome.byKind, undefined);
    }
});

test("a claim in prose about something outside the gold needs no verdict", () => {
    // It was never submitted, so there is nothing to rule on.
    assert.deepEqual(
        counts(
            score(judgedCase(), [
                claim(),
                claim({
                    requirementId: "mentioned_in_passing",
                    submittedAs: "prose",
                    sourceIndex: null,
                    speechAct: "mention",
                }),
            ])
        ),
        [1, 0, 0]
    );
});

// ---------------------------------------------------------------------------
// Precision eligibility
// ---------------------------------------------------------------------------

test("wrong findings are counted only where the gold claims to be complete", () => {
    assert.deepEqual(
        counts(
            score(judgedCase({ goldCompleteness: { missingPoints: false } }), [
                claim({ targetLabel: "a", outsideGoldVerdict: "false_finding" }),
            ])
        ),
        [0, 1, 0]
    );
});

test("an exhaustive and a non-exhaustive case do not produce the same object", () => {
    // Both count the hit for recall. Only one may enter a precision aggregate,
    // and an aggregator holding these objects has to be able to tell -- summing
    // `truePositives` across a mixed set is the failure the M5 contract names.
    const exhaustive = score(judgedCase(), [claim()]).byKind.missingPoints;
    const partial = score(judgedCase({ goldCompleteness: { missingPoints: false } }), [
        claim(),
    ]).byKind.missingPoints;

    assert.equal(exhaustive.truePositives, 1);
    assert.equal(partial.truePositives, 1, "recall counts every case");

    assert.equal(exhaustive.precisionCounted, true);
    assert.equal(partial.precisionCounted, false);
    assert.equal(exhaustive.precisionTruePositives, 1);
    assert.equal(
        partial.precisionTruePositives,
        0,
        "a non-exhaustive gold is excluded from precision's numerator as well as its denominator"
    );
    assert.notDeepEqual(exhaustive, partial);
});

// ---------------------------------------------------------------------------
// The record must be about this case, under this contract, and signed
// ---------------------------------------------------------------------------

test("a claim nobody confirmed stops the case being scored at all", () => {
    const outcome = score(judgedCase(), [
        claim(),
        claim({ status: "pending", confirmedBy: null, confirmedAt: null }),
    ]);
    assert.equal(outcome.scored, false);
    assert.match(outcome.reason, /is pending/);
    assert.equal(outcome.byKind, undefined);
});

test("confirmed without a signature is not confirmed", () => {
    // `status: "confirmed"` is a string anybody can write. A confirmation is a
    // person's act, so it names one and says when. This does not prove the
    // signature genuine; it stops an absent one being read as present.
    const unsigned = score(judgedCase(), [claim({ confirmedBy: null })]);
    assert.equal(unsigned.scored, false);
    assert.match(unsigned.reason, /confirmed by nobody/);

    const blank = score(judgedCase(), [claim({ confirmedBy: "   " })]);
    assert.equal(blank.scored, false);

    for (const at of [null, "", "someday", "곧"]) {
        const outcome = score(judgedCase(), [claim({ confirmedAt: at })]);
        assert.equal(outcome.scored, false, JSON.stringify(at));
        assert.match(outcome.reason, /is not a time/);
    }
});

test("a record about another case, or another contract, is refused", () => {
    // The identity travels with the CLAIMS. Checking only the case's own
    // version would let a record written under older rules, or about another
    // case, be scored against this one with nothing saying so.
    const otherCase = score(judgedCase(), [claim()], { caseId: "ko-safety-sensitive-001" });
    assert.equal(otherCase.scored, false);
    assert.match(otherCase.reason, /is about ko-safety-sensitive-001/);

    const otherContract = score(judgedCase(), [claim()], {
        contractVersion: "ai-review-scoring-judged-v0",
    });
    assert.equal(otherContract.scored, false);
    assert.match(otherContract.reason, /cannot be re-read under these/);

    const caseFromAnotherContract = scoreJudgedCase(
        judgedCase({ contractVersion: "ai-review-scoring-judged-v0" }),
        record([claim()])
    );
    assert.equal(caseFromAnotherContract.scored, false);
    assert.match(caseFromAnotherContract.reason, /do not carry across contracts/);
});

test("a record that does not say which output it read is refused", () => {
    const outcome = score(judgedCase(), [claim()], { observationRef: "" });
    assert.equal(outcome.scored, false);
    assert.match(outcome.reason, /which reviewer output/);
});

test("the observation reference is compared only when the caller says what it is", () => {
    // On its own this field is a "did anyone write it down" check, and the
    // contract says so rather than claiming more. Any non-empty string passes.
    assert.deepEqual(
        counts(score(judgedCase(), [claim()], { observationRef: "another-run/nowhere" })),
        [1, 0, 0]
    );

    // Given the output actually being scored, it becomes a comparison. Binding
    // that identifier to the output itself belongs with the evidence bundle.
    const mismatched = scoreJudgedCase(
        judgedCase(),
        record([claim()], { observationRef: "another-run/nowhere" }),
        { observationRef: "run-1/attempt-1" }
    );
    assert.equal(mismatched.scored, false);
    assert.match(mismatched.reason, /the output being\s+scored is run-1\/attempt-1/);

    const matched = scoreJudgedCase(judgedCase(), record([claim()]), {
        observationRef: "run-1/attempt-1",
    });
    assert.equal(matched.scored, true);
});

test("an empty record still has to be signed off as read through", () => {
    // "Read it through, there was nothing to report" and "nobody has started"
    // are the same empty array. Per-claim signatures cannot separate them --
    // there are no claims to sign -- so the record signs itself off.
    const unsigned = score(judgedCase(), [], { reviewedBy: "", reviewedAt: "" });
    assert.equal(unsigned.scored, false);
    assert.match(unsigned.reason, /signed the record off as read through/);
    assert.match(unsigned.reason, /is not a time/);

    // Signed, an empty record is a reviewer that found nothing: a miss, and no
    // wrong finding.
    assert.deepEqual(counts(score(judgedCase(), [])), [0, 1, 0]);
});

test("the record sign-off is checked even when every claim is signed", () => {
    const outcome = score(judgedCase(), [claim()], { reviewedBy: "  " });
    assert.equal(outcome.scored, false);
    assert.match(outcome.reason, /signed the record off as read through/);
});

test("the verifier lists every problem, rather than stopping at the first", () => {
    // So an operator fixes a record once instead of running it five times.
    const problems = verifyJudgementRecord(
        judgedCase(),
        record([claim({ confirmedBy: null, confirmedAt: "someday" }), claim({ status: "pending" })], {
            caseId: "elsewhere",
            observationRef: "",
            reviewedBy: "",
        })
    );
    assert.ok(problems.length >= 6, problems.join("\n"));
    assert.ok(problems.some((problem) => /signed the record off/.test(problem)));
    assert.ok(problems.some((problem) => /is about elsewhere/.test(problem)));
    assert.ok(problems.some((problem) => /which reviewer output/.test(problem)));
    assert.ok(problems.some((problem) => /confirmed by nobody/.test(problem)));
    assert.ok(problems.some((problem) => /is not a time/.test(problem)));
    assert.ok(problems.some((problem) => /is pending/.test(problem)));
});

test("a verified record has nothing to report", () => {
    assert.deepEqual(verifyJudgementRecord(judgedCase(), record([claim()])), []);
});

// ---------------------------------------------------------------------------
// The case's own registration
//
// A different question from anything the scorer asks, and it stays different:
// it constrains the case's GOLD and never a reviewer's finding.
// ---------------------------------------------------------------------------

test("a gold naming an unregistered requirement or a missing answer is refused", () => {
    // A mistyped id would otherwise become a gold item nothing could satisfy,
    // and the miss would be recorded against the reviewer.
    const mistyped = judgedCase({
        gold: { missingPoints: [{ requirementId: "objection_deadlien", targetLabel: "c" }] },
    });
    assert.ok(
        validateJudgedCase(mistyped).some((problem) =>
            /does not register/.test(problem)
        ),
        validateJudgedCase(mistyped).join("\n")
    );

    const wrongLabel = judgedCase({
        gold: { missingPoints: [{ requirementId: DEADLINE, targetLabel: "d" }] },
    });
    assert.ok(
        validateJudgedCase(wrongLabel).some((problem) => /does not have/.test(problem))
    );

    // And a caller cannot skip it: the scorer runs it too.
    const outcome = score(mistyped, [claim()]);
    assert.equal(outcome.scored, false);
    assert.match(outcome.reason, /does not register/);
});

test("a completeness claim has to be stated wherever there is gold", () => {
    // Whether wrong findings may be counted at all depends on it, so it is not
    // something a case may leave unsaid.
    const unsaid = judgedCase({ goldCompleteness: {} });
    assert.ok(
        validateJudgedCase(unsaid).some((problem) =>
            /cannot be left unsaid/.test(problem)
        )
    );
    // And stating it where there is no gold is a different mistake, also named.
    const orphan = judgedCase({
        gold: { missingPoints: [{ requirementId: DEADLINE, targetLabel: "c" }] },
        goldCompleteness: { missingPoints: true, contradictions: false },
    });
    assert.ok(
        validateJudgedCase(orphan).some((problem) =>
            /there is no contradictions gold/.test(problem)
        )
    );
});

test("registration says nothing about what a reviewer may report", () => {
    // The boundary. A finding about an unregistered requirement is a JUDGEMENT
    // -- settled by `outsideGoldVerdict` -- and never a registration error.
    // Closing that route would close the only way this contract has of
    // discovering that a gold is short an item.
    assert.deepEqual(validateJudgedCase(judgedCase()), []);
    const outcome = score(judgedCase({ goldCompleteness: { missingPoints: false } }), [
        claim(),
        claim({
            requirementId: "never_registered_anywhere",
            sourceIndex: 1,
            outsideGoldVerdict: "gold_incomplete",
        }),
    ]);
    assert.deepEqual(counts(outcome), [1, 0, 0]);
    assert.equal(outcome.byKind.missingPoints.goldGaps, 1);
});

test("a duplicated gold item and a duplicated requirement are both named", () => {
    const twice = judgedCase({
        gold: {
            missingPoints: [
                { requirementId: DEADLINE, targetLabel: "c" },
                { requirementId: DEADLINE, targetLabel: "c" },
            ],
        },
    });
    assert.ok(validateJudgedCase(twice).some((problem) => /lists c objection_deadline twice/.test(problem)));

    const registeredTwice = judgedCase({
        requirements: [
            { id: DEADLINE, description: "기한" },
            { id: DEADLINE, description: "기한, 다시" },
        ],
    });
    assert.ok(
        validateJudgedCase(registeredTwice).some((problem) => /registered twice/.test(problem))
    );
});
