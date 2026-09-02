// The v2 drafting contract: the position of the planted fault is assigned, the
// labels are checked rather than filled in, and a stub answer fails the batch.
//
// v1 had none of these, and the first paid batch showed why: seven cases, the
// fault in "c" every time, answers averaging 108 characters. Each case was
// well formed. The set would have measured position and brevity.

import assert from "node:assert/strict";
import test from "node:test";

import {
  DRAFT_MIN_RESPONSE_CHARACTERS,
  ANSWER_SHAPE,
  DRAFT_RESPONSE_LABELS,
  DRAFT_TARGET_RESPONSE_RANGE,
  assignTargetLabels,
  draftInstruction,
  parseDraftedCases,
} from "../lib/aiReviewEvalDraftPrompt.ts";
import { AI_REVIEW_EVAL_TASK_TYPES } from "../lib/aiReviewEvalCore.ts";

const cell = {
  language: "ko",
  taskType: "safety_sensitive",
  phenomenon: "direct_contradiction",
  mode: "balanced",
};

const long = (marker) => `${marker} `.repeat(120).trim();

const reply = (cases) => JSON.stringify({ cases });

const caseWith = (labels, { contentLength = "long" } = {}) => ({
  question: "질문",
  responses: labels.map((label) => ({
    label,
    content: contentLength === "long" ? long(`answer ${label}`) : "짧다",
  })),
  gold: { contradictions: [{ id: "x", anyOf: ["x"], description: "x" }] },
  goldCompleteness: { contradictions: true },
});

test("seven cases spread the planted answer across the three labels", () => {
  const labels = assignTargetLabels({ ...cell, count: 7 });
  assert.equal(labels.length, 7);
  const counts = {};
  for (const label of labels) counts[label] = (counts[label] ?? 0) + 1;
  // Balanced: no label carries more than one extra over any other.
  const values = Object.values(counts).sort();
  assert.equal(values.length, 3);
  assert.equal(values[values.length - 1] - values[0], 1);
  assert.deepEqual(values, [2, 2, 3]);
});

test("the assignment is a pure function of the cell, not of when it ran", () => {
  assert.deepEqual(
    assignTargetLabels({ ...cell, count: 7 }),
    assignTargetLabels({ ...cell, count: 7 })
  );
  // Different cells do not all open on the same label, or every run's first
  // case would carry the fault in one place.
  const starts = new Set(
    ["ko", "en"].flatMap((language) =>
      ["safety_sensitive", "planning_decision", "omission_cell"].map(
        (taskType) => assignTargetLabels({ ...cell, language, taskType, count: 1 })[0]
      )
    )
  );
  assert.ok(starts.size > 1, "every cell started on the same label");
});

test("a phenomenon that plants nothing is assigned nothing", () => {
  // position_bias especially: it is the case that tests whether position fools
  // a reviewer, so assigning it a position would assign the thing under test.
  for (const phenomenon of ["genuine_consensus", "no_issue", "verbosity_bias", "position_bias"]) {
    const labels = assignTargetLabels({ ...cell, phenomenon, count: 4 });
    assert.deepEqual([...labels], [null, null, null, null], phenomenon);
  }
});

test("the instruction names the assigned answer for every case", () => {
  const targetLabels = assignTargetLabels({ ...cell, count: 3 });
  const instruction = draftInstruction({
    ...cell,
    count: 3,
    existingQuestions: [],
    targetLabels,
  });
  for (const [index, label] of targetLabels.entries()) {
    assert.match(instruction, new RegExp(`case ${index + 1}: answer "${label}"`));
  }
  assert.match(instruction, /Do not move it/);
  // Length is asked for as a structure, not as a number. Raising the number
  // was tried twice and did not work: v2 asked for 200 and got 162-190, v3
  // asked for 500 and got 215 -- three elements at about seventy characters
  // each, which is exactly what v3's three-element frame produces.
  for (const element of ANSWER_SHAPE[cell.taskType]) {
    assert.match(instruction, new RegExp(element.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(
    instruction,
    new RegExp(
      `${DRAFT_TARGET_RESPONSE_RANGE.min}-${DRAFT_TARGET_RESPONSE_RANGE.max} characters`
    )
  );
  assert.match(instruction, new RegExp(`not go under ${DRAFT_MIN_RESPONSE_CHARACTERS}`));
  // The one-difference rule is what makes an exhaustive gold honest: a planted
  // answer careless in a second way scores a reviewer wrong for finding it.
  assert.match(instruction, /differs from the others on ONE point/);
});

test("an instruction cannot be built with the wrong number of assignments", () => {
  assert.throws(
    () =>
      draftInstruction({ ...cell, count: 3, existingQuestions: [], targetLabels: ["a"] }),
    /3 case\(s\) asked for and 1 target label\(s\) given/
  );
});

test("labels are checked, never filled in", () => {
  const expected = { targetLabels: ["a", "a", "a", "a"], minResponseCharacters: 0 };

  const missing = parseDraftedCases(
    reply([{ ...caseWith(["a", "b"]), responses: [{ content: long("x") }, { label: "b", content: long("y") }] }]),
    { targetLabels: ["a"], minResponseCharacters: 0 }
  );
  assert.equal(missing.cases.length, 0);
  assert.match(missing.problems[0], /no label/);

  const duplicate = parseDraftedCases(reply([caseWith(["a", "a"])]), expected);
  assert.equal(duplicate.cases.length, 0);
  assert.match(duplicate.problems[0], /share a label/);

  const unknown = parseDraftedCases(reply([caseWith(["a", "answer 2"])]), expected);
  assert.equal(unknown.cases.length, 0);
  assert.match(unknown.problems[0], /are not among a, b, c/);

  const absentTarget = parseDraftedCases(reply([caseWith(["a", "b"])]), {
    targetLabels: ["c"],
    minResponseCharacters: 0,
  });
  assert.equal(absentTarget.cases.length, 0);
  assert.match(absentTarget.problems[0], /assigned to "c"/);
});

test("a stub answer is refused rather than accepted into the cell", () => {
  const short = parseDraftedCases(reply([caseWith(["a", "b", "c"], { contentLength: "short" })]), {
    targetLabels: ["a"],
    minResponseCharacters: DRAFT_MIN_RESPONSE_CHARACTERS,
  });
  assert.equal(short.cases.length, 0);
  // Every length is named, so a near-miss and a stub are distinguishable.
  assert.match(short.problems[0], /3 of 3 answer\(s\) below 200 characters \(lengths /);
});

test("an accepted case remembers which case of the batch it was", () => {
  // The assignment is per requested case and the parser drops what it refuses,
  // so a rejection shifts every later case's position in the accepted list.
  // Recording the assigned label off that position would put the wrong one on
  // every case after the first rejection.
  const parsed = parseDraftedCases(
    reply([caseWith(["a", "a"]), caseWith(["a", "b", "c"]), caseWith(["a", "b", "c"])]),
    { targetLabels: ["a", "b", "c"], minResponseCharacters: 0 }
  );
  assert.equal(parsed.cases.length, 2);
  assert.deepEqual(
    parsed.cases.map((item) => item.requestIndex),
    [1, 2]
  );
});

test("the allowed labels are the ones the dataset rule allows", () => {
  assert.deepEqual([...DRAFT_RESPONSE_LABELS], ["a", "b", "c"]);
});

test("the answer shape is per task type, not one frame for the whole set", () => {
  // A single five-sentence skeleton imposed everywhere becomes its own pattern:
  // every answer in the set built the same way, and a reviewer that learns the
  // skeleton learns something the evaluation did not mean to teach it. That is
  // the position confound again in different clothes.
  assert.equal(ANSWER_SHAPE.safety_sensitive.length, 5);
  for (const [taskType, shape] of Object.entries(ANSWER_SHAPE)) {
    if (taskType === "safety_sensitive") continue;
    assert.equal(shape.length, 3, `${taskType} was widened without being measured`);
  }
  // Every task type has one, so no cell falls back to an unstated shape.
  for (const taskType of AI_REVIEW_EVAL_TASK_TYPES) {
    assert.ok(ANSWER_SHAPE[taskType]?.length > 0, taskType);
  }
  // And each cell's instruction carries its own, not another's.
  const planning = draftInstruction({
    ...cell,
    taskType: "planning_decision",
    count: 1,
    existingQuestions: [],
    targetLabels: assignTargetLabels({ ...cell, taskType: "planning_decision", count: 1 }),
  });
  assert.match(planning, /the trade-off behind it/);
  assert.doesNotMatch(planning, /the warning signs or cautions that matter/);
});
