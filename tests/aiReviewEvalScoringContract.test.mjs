// What `anyOf` scoring can and cannot tell apart.
//
// These tests do not describe behaviour anybody wants. They pin the gap, so
// that the day a scoring contract is written they FAIL and have to be
// rewritten deliberately rather than quietly kept passing.
//
// The gap was found on 2026-09-08 while reviewing the v9 omission candidates.
// Those golds were written with answer-shaped phrases (`"송달받은 날부터 2주
// 이내"`), and a reviewer reporting the omission correctly would not contain
// that sentence -- so a correct review scored zero. The obvious repair, short
// central terms (`"2주"`, `"14일"`), fixes that and buys something worse: the
// mis-accusation and the flat contradiction of the finding score identically
// to the correct one.
//
// So `anyOf` is a KEYWORD PRESENCE TEST. It answers "does this text mention
// the thing the gold is about". It does not answer any of:
//
//   * which answer the reviewer accused;
//   * whether the reviewer said the element was MISSING or PRESENT;
//   * whether the reviewer reported a finding at all.
//
// Three different reviews -- one right, one accusing the wrong answer, one
// asserting the opposite -- are one string to it.
//
// What replaces it is `lib/aiReviewEvalJudgement.ts`, whose requirements are
// stated in `tests/aiReviewEvalJudgementScoring.test.mjs`. Until that contract
// is wired into an evaluation, both files stand: this one says what today's
// scorer does, and that one says what a scorer has to do.

import assert from "node:assert/strict";
import test from "node:test";

import {
  AI_REVIEW_KEYWORD_DIAGNOSTIC_GATE_CONNECTIONS,
  AI_REVIEW_KEYWORD_DIAGNOSTIC_NOTICE,
  scoreCase,
} from "../lib/aiReviewEvalCore.ts";

/** A case whose gold names one missing point, declared exhaustive. */
const caseWithGold = (gold) => ({
  id: "ko-safety-sensitive-003",
  language: "ko",
  taskType: "safety_sensitive",
  phenomenon: "omission",
  mode: "balanced",
  question: "지급명령에 어떻게 대응해야 합니까?",
  responses: ["a", "b", "c"].map((label) => ({
    label,
    modelId: "drafted",
    provider: "drafted",
    content: `${label}의 답변`,
  })),
  gold: { missingPoints: [gold] },
  goldCompleteness: { missingPoints: true },
  status: "candidate",
  adoptedBy: null,
});

const reporting = (text) => ({
  findings: { contradictions: [], missingPoints: [text], differences: [] },
  allText: text,
  reviewerProse: text,
  totalQuotes: 0,
  matchedQuotes: 0,
});

const score = (gold, text) =>
  scoreCase(caseWithGold(gold), reporting(text)).byKind.missingPoints;

/** The four reviews a real evaluation has to tell apart. c is the answer at fault. */
const CORRECT = "c에는 2주 이의신청 기한이 빠져 있다";
const WRONG_ANSWER = "a에는 2주 이의신청 기한이 빠져 있다";
const OPPOSITE = "c에는 2주 기한이 명시되어 있어 누락이 없다";
const SYNONYM = "c는 이의신청을 14일 안에 하라는 기한을 말하지 않는다";
const UNRELATED = "세 답변 모두 잘 작성되었다";

const SHORT_TERMS = {
  id: "two-week-objection-deadline",
  anyOf: ["2주", "14일", "두 주"],
  description: "c가 법정 기한을 제시하지 않는다",
};

test("short terms score a right review, a wrong one and its opposite identically", () => {
  // The measurement that stopped the `anyOf` replacement being adopted.
  const correct = score(SHORT_TERMS, CORRECT);
  assert.deepEqual(
    [correct.truePositives, correct.falseNegatives, correct.falsePositives],
    [1, 0, 0]
  );

  // Accusing the wrong answer. Scored the same as being right.
  const wrong = score(SHORT_TERMS, WRONG_ANSWER);
  assert.deepEqual(
    [wrong.truePositives, wrong.falseNegatives, wrong.falsePositives],
    [1, 0, 0],
    "a mis-accusation no longer scores as a hit -- rewrite this test"
  );

  // Asserting the element IS there, which is the flat contradiction of the
  // finding. Also scored as finding it.
  const opposite = score(SHORT_TERMS, OPPOSITE);
  assert.deepEqual(
    [opposite.truePositives, opposite.falseNegatives, opposite.falsePositives],
    [1, 0, 0],
    "the opposite claim no longer scores as a hit -- rewrite this test"
  );
});

test("the one thing short terms do buy is a synonym", () => {
  // Not nothing: "14일" and "2주" are the same deadline, and a reviewer may
  // write either. This is why the answer is not simply to make terms longer.
  const synonym = score(SHORT_TERMS, SYNONYM);
  assert.equal(synonym.truePositives, 1);
  assert.equal(synonym.falsePositives, 0);
});

test("a review that reports nothing relevant is still counted correctly", () => {
  // The one discrimination that does work, and the reason the measure is not
  // useless: silence is not a hit.
  const unrelated = score(SHORT_TERMS, UNRELATED);
  assert.deepEqual(
    [unrelated.truePositives, unrelated.falseNegatives, unrelated.falsePositives],
    [0, 1, 1]
  );
});

test("answer-shaped terms miss the correct review, which is how this was found", () => {
  // What the v9 batch shipped. `anyOf` is matched against the REVIEWER'S
  // finding, and these are sentences an ANSWER would contain, so the correct
  // review scores a false negative and a false positive at once.
  const answerShaped = {
    id: "two-week-objection-deadline",
    anyOf: ["송달받은 날부터 2주 이내", "2주 이내에 이의신청"],
    description: "c가 법정 기한을 제시하지 않는다",
  };
  for (const text of [CORRECT, SYNONYM]) {
    const outcome = score(answerShaped, text);
    assert.deepEqual(
      [outcome.truePositives, outcome.falseNegatives, outcome.falsePositives],
      [0, 1, 1],
      text
    );
  }
});

test("mustAlsoContain with a label separates the wrong answer, and nothing else", () => {
  // The repair that suggests itself, measured rather than assumed.
  const labelled = { ...SHORT_TERMS, mustAlsoContain: ["c"] };

  // It does separate the mis-accusation.
  const wrong = score(labelled, WRONG_ANSWER);
  assert.deepEqual(
    [wrong.truePositives, wrong.falseNegatives, wrong.falsePositives],
    [0, 1, 1]
  );
  assert.equal(score(labelled, CORRECT).truePositives, 1);

  // It does NOT separate the opposite claim, which names the same answer.
  const opposite = score(labelled, OPPOSITE);
  assert.equal(
    opposite.truePositives,
    1,
    "the opposite claim no longer scores as a hit -- rewrite this test"
  );

  // And the separation it does buy is not robust: a mis-accusation that names
  // the right answer anywhere at all passes the label test.
  const wrongButMentionsC = score(
    labelled,
    "a에는 2주 기한이 빠져 있다. b와 c는 기한을 명시한다."
  );
  assert.equal(
    wrongButMentionsC.truePositives,
    1,
    "a label mention no longer admits a mis-accusation -- rewrite this test"
  );
});

test("a single-character label term is a substring of ordinary words", () => {
  // Why a label cannot simply be bolted onto the existing matcher: the terms
  // are compared with `includes()` after lowercasing, so any Latin `c` in the
  // reviewer's prose satisfies `mustAlsoContain: ["c"]`.
  const labelled = { ...SHORT_TERMS, mustAlsoContain: ["c"] };
  const mentionsNoAnswer = score(
    labelled,
    "2주 기한에 대한 check 결과 누락이 있다"
  );
  assert.equal(
    mentionsNoAnswer.truePositives,
    1,
    "an incidental Latin c no longer satisfies the label -- rewrite this test"
  );
});

// ---------------------------------------------------------------------------
// Naming the screen a screen, without moving anything it is wired to
// ---------------------------------------------------------------------------

test("the keyword notice says what the counts cannot answer", () => {
    // One sentence, one place. Every surface prints this constant rather than
    // its own paraphrase, so the four metrics cannot end up described one way
    // in a CLI and another in a report.
    const notice = AI_REVIEW_KEYWORD_DIAGNOSTIC_NOTICE;
    assert.match(notice, /Keyword diagnostic, not semantic accuracy/);
    // The questions the substring test cannot answer, each named.
    assert.match(notice, /which answer was accused/);
    assert.match(notice, /missing or present/);
    // Field scoping is REAL and meaning is not: claiming it cannot tell a
    // finding from prose would understate it in one place and overstate it in
    // another, so the notice has to say both halves.
    assert.match(notice, /Only that kind's findings field is read/);
    assert.match(notice, /a quotation and an aside are indistinguishable/);
    // The derived rate rides on the same matching and must be named with them.
    assert.match(notice, /false-consensus rate derived from them/);
    // And it must not claim the screen is merely imprecise in one direction.
    assert.match(notice, /wrong in both directions/);
});

test("the screen scopes by field but not by meaning", () => {
    // Both halves measured, because the description of this screen was wrong
    // in each direction at some point: too generous about what it separates,
    // then too harsh.
    const outsideTheField = scoreCase(caseWithGold(SHORT_TERMS), {
        findings: { contradictions: [], missingPoints: [], differences: [] },
        allText: CORRECT,
        reviewerProse: CORRECT,
        totalQuotes: 0,
        matchedQuotes: 0,
    }).byKind.missingPoints;
    assert.equal(outsideTheField.truePositives, 0);

    // The same terms inside the field, as a quotation of the answer rather
    // than a finding about it. Indistinguishable to a substring test.
    const quotedInsideTheField = score(
        SHORT_TERMS,
        'c의 원문을 인용하면 "...2주 이내..."라고 적혀 있다'
    );
    assert.equal(quotedInsideTheField.truePositives, 1);
});

test("false consensus rides on the same matching, and invented issues do not", () => {
    // A reviewer that reported the planted omission in its own words is
    // recorded as having agreed with everything; one that named the term while
    // denying the gold is not. Neither is about what the reviewer meant.
    // A term list that carries only one wording, so the synonym really is one
    // the list does not have -- SHORT_TERMS lists `14일` itself.
    const ONE_WORDING = {
        id: "two-week-objection-deadline",
        anyOf: ["2주"],
        description: "c가 법정 기한을 제시하지 않는다",
    };
    const synonym = scoreCase(caseWithGold(ONE_WORDING), reporting(SYNONYM));
    assert.equal(synonym.byKind.missingPoints.truePositives, 0);
    assert.equal(synonym.falseConsensus, true);

    const denial = scoreCase(caseWithGold(ONE_WORDING), reporting(OPPOSITE));
    assert.equal(denial.byKind.missingPoints.truePositives, 1);
    assert.equal(denial.falseConsensus, false);

    // The invented-issue flag counts submissions on a no-issue case and never
    // reads the terms, so it must not be described as keyword-derived.
    const noIssue = {
        ...caseWithGold(SHORT_TERMS),
        phenomenon: "genuine_consensus",
        gold: { missingPoints: [] },
    };
    const invented = scoreCase(noIssue, {
        findings: {
            contradictions: ["아무 근거 없는 모순 주장"],
            missingPoints: [],
            differences: [],
        },
        allText: "아무 근거 없는 모순 주장",
        reviewerProse: "아무 근거 없는 모순 주장",
        totalQuotes: 0,
        matchedQuotes: 0,
    });
    assert.equal(invented.inventedIssue, true);
});

test("the label does not pretend the numbers were disconnected", () => {
    // The failure this guards against is a relabelling that reads as a fix.
    // These counts still reach the approval decision, so the connection is
    // carried beside the label and names each hop.
    assert.ok(AI_REVIEW_KEYWORD_DIAGNOSTIC_GATE_CONNECTIONS.length >= 3);
    const joined = AI_REVIEW_KEYWORD_DIAGNOSTIC_GATE_CONNECTIONS.join(" ");
    for (const hop of [
        "scoreCase()",
        "falseConsensus",
        "falseConsensusRateWilsonUpper",
        "aggregateOutcomes()",
        "thresholdShortfalls()",
        "approvedEntryProblems()",
        "check:ai-review-eval",
    ]) {
        assert.ok(joined.includes(hop), hop);
    }
});

test("naming the screen changed no count and no field", () => {
    // Past artifacts are evidence: they carry these field names and must keep
    // verifying. The rename that would have been tidiest is the one that would
    // have broken them, so the outcome shape is pinned here exactly.
    const outcome = score(SHORT_TERMS, CORRECT);
    assert.deepEqual(Object.keys(outcome).sort(), [
        "falseNegatives",
        "falsePositives",
        "precisionCounted",
        "reported",
        "truePositives",
    ]);
    // And the arithmetic is the same arithmetic: this is the row the contract
    // test above calls a correct finding.
    assert.equal(outcome.truePositives, 1);
});
