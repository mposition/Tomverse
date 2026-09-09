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
    judgementRecordShapeProblems,
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
    sourceCaseDigest: "sha256:the-question-and-answers-a-person-read",
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
    // Two SUBMITTED items saying the same thing. That is the reviewer padding
    // its own output, which is what `duplicates` is for -- and since v3 it is
    // the only thing it counts, because two identical claims out of one item
    // are an extraction error rather than a repetition by the reviewer.
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

// ---------------------------------------------------------------------------
// v2: the claim's scoring role, and a finding judged insufficient
//
// Approved 2026-09-08. The comparison that chose these is in
// `.github/audits/ai-review-scoring-policy-decision-2026-09-08.md`, and its
// four inputs are the first four tests here -- an option that fixes the first
// and breaks the third is the failure this axis exists to avoid.
// ---------------------------------------------------------------------------

const SUPPORT_QUOTE = "다만 증빙 보존은 이미 안내돼 있다";

test("a supporting remark beside a finding is not a second finding", () => {
    // Input 1. Both claims came out of ONE submitted item: the first reports
    // the gold, the second explains. Extracted as a finding it used to be a
    // wrong finding, which punished a reviewer for saying something true.
    const outcome = score(judgedCase(), [
        claim({ role: "finding" }),
        claim({
            requirementId: "evidence_preservation",
            assertion: "present",
            speechAct: "mention",
            evidenceQuote: SUPPORT_QUOTE,
            role: "support",
        }),
    ]);
    assert.deepEqual(counts(outcome), [1, 0, 0]);
    assert.equal(outcome.byKind.missingPoints.supportClaims, 1);
});

test("an independent invented finding stays a wrong finding", () => {
    // Input 2. The role axis must not become a way to drop these. Marked as a
    // finding, it scores exactly as it did before the axis existed.
    assert.deepEqual(
        counts(
            score(judgedCase(), [
                claim({ role: "finding" }),
                claim({
                    requirementId: "transport_mode",
                    evidenceQuote: "c는 이송 수단을 말하지 않는다",
                    outsideGoldVerdict: "false_finding",
                    role: "finding",
                }),
            ])
        ),
        [1, 0, 1]
    );
});

test("a submission that is only a quotation still scores as a wrong finding", () => {
    // Input 3, and the reason `support` is a DEPENDENT role. Excluding every
    // non-`finding` speech act instead would drop this to FP 0 and overturn a
    // rule the contract already settled: what is put in a findings field is a
    // finding, whatever it contains.
    const outcome = score(judgedCase(), [
        claim({ speechAct: "quotation", role: "support" }),
    ]);
    assert.deepEqual(counts(outcome), [0, 1, 1]);
    assert.equal(outcome.byKind.missingPoints.supportClaims, 0);
});

test("opposite assertions in one submission are not merged away", () => {
    // Input 4. The triple is the key a claim is matched by, never a licence to
    // fold two different assertions into one claim.
    assert.deepEqual(
        counts(
            score(judgedCase(), [
                claim(),
                claim({ assertion: "present", evidenceQuote: "c에는 기한이 이미 있다" }),
            ])
        ),
        [1, 0, 1]
    );
});

test("a claim with no role is scored", () => {
    // The default is `finding` on purpose: a forgotten mark must never be the
    // quiet way to delete a finding.
    assert.deepEqual(counts(score(judgedCase(), [claim()])), [1, 0, 0]);
});

test("supporting material does not need an outside-gold verdict", () => {
    // It is not a finding the reviewer put forward, so there is no question
    // about whether they invented it. The cost is stated in the next test.
    const outcome = score(judgedCase(), [
        claim(),
        claim({
            requirementId: "transport_mode",
            speechAct: "mention",
            evidenceQuote: "이송 수단은 질문 밖이다",
            role: "support",
        }),
    ]);
    assert.deepEqual(counts(outcome), [1, 0, 0]);
});

test("KNOWN GAP: an invented finding mislabelled as support loses its FP", () => {
    // Pinned deliberately, the way the keyword-scorer gap is pinned. The
    // dependency check asks whether an independent claim sits beside this one,
    // and it cannot ask whether the mark is honest.
    //
    // The contract's answer is COUNTING, not detection: the claim lands in
    // `supportClaims`, so an output full of them is visible. If a later change
    // makes this detectable, this test fails and that is the good outcome.
    const outcome = score(judgedCase(), [
        claim({ role: "finding" }),
        claim({
            requirementId: "transport_mode",
            evidenceQuote: "c는 이송 수단을 말하지 않는다",
            role: "support",
        }),
    ]);
    assert.deepEqual(counts(outcome), [1, 0, 0]);
    assert.equal(outcome.byKind.missingPoints.supportClaims, 1);
});

test("an insufficient finding is not a hit, and its gold item stays unmatched", () => {
    // Judged complete and judged inadequate. Before this state a person had to
    // write `pending` (the judging is not finished) or `false_finding` (the
    // requirement is invented), and both say something untrue.
    const outcome = score(judgedCase(), [
        claim({ evidenceQuote: "c의 기한 안내는 부족하다", sufficiency: "insufficient" }),
    ]);
    assert.deepEqual(counts(outcome), [0, 1, 1]);
    assert.equal(outcome.byKind.missingPoints.insufficientFindings, 1);
});

test("insufficient findings are counted apart from invented ones", () => {
    // `falsePositives` now holds two different things, so nothing that
    // measures invention may be derived from it -- the invented-issue rate is
    // a per-case ratio over no-issue cases, not a false-positive count.
    const outcome = score(judgedCase(), [
        claim({ evidenceQuote: "c의 기한 안내는 부족하다", sufficiency: "insufficient" }),
        claim({
            requirementId: "transport_mode",
            sourceIndex: 1,
            evidenceQuote: "c는 이송 수단을 말하지 않는다",
            outsideGoldVerdict: "false_finding",
        }),
    ]);
    assert.deepEqual(counts(outcome), [0, 1, 2]);
    assert.equal(outcome.byKind.missingPoints.insufficientFindings, 1);
});

test("an insufficient finding costs precision only where the gold is exhaustive", () => {
    // Same rule every other wrong finding follows: an incomplete gold cannot
    // tell an extra finding from one it forgot.
    const outcome = score(
        judgedCase({ goldCompleteness: { missingPoints: false } }),
        [claim({ evidenceQuote: "c의 기한 안내는 부족하다", sufficiency: "insufficient" })]
    );
    assert.deepEqual(counts(outcome), [0, 1, 0]);
    assert.equal(outcome.byKind.missingPoints.precisionCounted, false);
    assert.equal(outcome.byKind.missingPoints.insufficientFindings, 1);
});

test("insufficiency is refused where another axis already answers", () => {
    // Three places it must not be written, each refused rather than ignored:
    // supporting material is not scored, prose was never submitted, and a
    // claim outside the gold is settled by `outsideGoldVerdict`.
    const cases = [
        [{ role: "support", sufficiency: "insufficient" }, "supporting material is not scored"],
        [
            { submittedAs: "prose", sourceIndex: null, sufficiency: "insufficient" },
            "never submitted as a finding",
        ],
        [
            { targetLabel: "a", outsideGoldVerdict: "false_finding", sufficiency: "insufficient" },
            "settled by outsideGoldVerdict",
        ],
    ];
    for (const [overrides, fragment] of cases) {
        const problems = verifyJudgementRecord(judgedCase(), record([claim(overrides)]));
        assert.ok(
            problems.some((problem) => problem.includes(fragment)),
            `${JSON.stringify(overrides)} -> ${JSON.stringify(problems)}`
        );
    }
});

test("a record written under the previous contract is refused, not converted", () => {
    // The rules moved, so the same record can score differently. Old scores
    // are re-judged or left alone; they are never carried across.
    const problems = verifyJudgementRecord(
        judgedCase(),
        record([claim()], { contractVersion: "ai-review-scoring-judged-v1" })
    );
    assert.ok(problems.some((problem) => problem.includes("cannot be re-read under these")));
});

test("vagueness reaches the aggregate as submissions, not as silence", () => {
    // The decision that chose this option: excluding insufficient findings
    // from the denominator measures the accuracy of whatever survives the
    // exclusion, which says nothing about vagueness. Counting them makes
    // precision fall with it.
    const requirements = Array.from({ length: 10 }, (_, index) => ({
        id: `req-${index + 1}`,
        description: `요구 ${index + 1}`,
    }));
    const outcome = score(
        judgedCase({
            requirements,
            gold: {
                missingPoints: requirements.map((requirement) => ({
                    requirementId: requirement.id,
                    targetLabel: "c",
                })),
            },
        }),
        requirements.map((requirement, index) =>
            claim({
                requirementId: requirement.id,
                sourceIndex: index,
                evidenceQuote: `c의 ${requirement.id} 안내`,
                ...(index < 2 ? {} : { sufficiency: "insufficient" }),
            })
        )
    );
    assert.deepEqual(counts(outcome), [2, 8, 8]);
    assert.equal(outcome.byKind.missingPoints.insufficientFindings, 8);
});

test("a mistyped role or sufficiency is reported, not defaulted", () => {
    // `"suport"` would otherwise read as `finding` and score the claim --
    // silently the opposite of what somebody wrote.
    const problems = judgementRecordShapeProblems(
        record([claim({ role: "suport", sufficiency: "kind-of" })])
    );
    assert.ok(problems.some((problem) => problem.includes("claims[0].role")));
    assert.ok(problems.some((problem) => problem.includes("claims[0].sufficiency")));
});

// ---------------------------------------------------------------------------
// v3: one claim per triple, per submitted item
//
// Approved 2026-09-09 (mposition). The comparison is in
// `.github/audits/ai-review-decomposition-atomicity-2026-09-09.md`. This is an
// EXTRACTION rule, so it changes no arithmetic -- and the contract version
// still moves, because a record written the old way scores as though the rule
// had been followed.
// ---------------------------------------------------------------------------

test("the same judgement twice out of one submitted item is refused", () => {
    // Not folded. Folding would quietly change a score -- a repeated false or
    // insufficient finding costs one false positive per claim -- and a rule
    // enforced by silently rewriting the record is one nobody can see broken.
    const problems = verifyJudgementRecord(judgedCase(), record([claim(), claim()]));
    assert.ok(
        problems.some((problem) => problem.includes("repeats claim[0] exactly")),
        JSON.stringify(problems)
    );
});

test("an opposite assertion out of the same item is a different claim", () => {
    // The triple is the key a claim is matched by, never a licence to merge
    // what a submission actually asserted. This is the distinction the whole
    // decomposition policy turns on, so it is checked directly.
    assert.deepEqual(
        verifyJudgementRecord(
            judgedCase(),
            record([claim(), claim({ assertion: "present" })])
        ),
        []
    );
});

test("differing on any judged axis keeps two claims", () => {
    // Everything a person decided about the sentence is part of "the same
    // judgement": a mention is not a finding, supporting material is not a
    // finding, and an insufficient finding is not a sufficient one.
    for (const overrides of [
        { speechAct: "mention" },
        { role: "support" },
        { sufficiency: "insufficient" },
        { targetLabel: "a", outsideGoldVerdict: "false_finding" },
    ]) {
        assert.deepEqual(
            verifyJudgementRecord(judgedCase(), record([claim(), claim(overrides)])),
            [],
            JSON.stringify(overrides)
        );
    }
});

test("the same judgement out of two submitted items is the reviewer's repetition", () => {
    // Not an extraction error: the reviewer really did file it twice. It stays
    // scoreable and lands in `duplicates`.
    assert.deepEqual(
        verifyJudgementRecord(judgedCase(), record([claim(), claim({ sourceIndex: 1 })])),
        []
    );
});

test("a v2 record is refused, not re-read under the v3 extraction rule", () => {
    // v3 computes nothing differently. It moves because a record extracted
    // submission-unit style would be scored as though one claim per triple had
    // been extracted, and that number would be about a rule nobody followed.
    const problems = verifyJudgementRecord(
        judgedCase(),
        record([claim()], { contractVersion: "ai-review-scoring-judged-v2" })
    );
    assert.ok(problems.some((problem) => problem.includes("cannot be re-read under these")));
});

test("RESIDUAL: how many ids the judge assigns outside the gold still moves the score", () => {
    // Approved as unsolved, not as solved (2026-09-09). C1 keys a claim by the
    // triple, and that is mechanical only AFTER the id exists: how many ids one
    // sentence of content outside the gold becomes is still a reading, and the
    // reading is worth one false positive.
    //
    // Pinned so the limit is a recorded fact rather than a remembered caveat.
    // If a later rule narrows it, this test fails and that is the good outcome.
    const oneId = score(judgedCase(), [
        claim({
            targetLabel: "a",
            requirementId: "transport_mode",
            evidenceQuote: "c는 이송 수단과 비용을 말하지 않는다",
            outsideGoldVerdict: "false_finding",
        }),
    ]);
    const twoIds = score(judgedCase(), [
        claim({
            targetLabel: "a",
            requirementId: "transport_mode",
            evidenceQuote: "c는 이송 수단과",
            outsideGoldVerdict: "false_finding",
        }),
        claim({
            targetLabel: "a",
            requirementId: "evidence_preservation",
            evidenceQuote: "비용을 말하지 않는다",
            outsideGoldVerdict: "false_finding",
        }),
    ]);
    assert.deepEqual(counts(oneId), [0, 1, 1]);
    assert.deepEqual(counts(twoIds), [0, 1, 2]);
});
