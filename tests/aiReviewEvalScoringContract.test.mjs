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

import { scoreCase } from "../lib/aiReviewEvalCore.ts";

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
