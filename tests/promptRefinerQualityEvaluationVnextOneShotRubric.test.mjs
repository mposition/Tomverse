import assert from "node:assert/strict";
import test from "node:test";
import {
  validatePromptRefinerVnextOneShotRubric as validate,
} from "../lib/promptRefinerQualityEvaluationVnextOneShotRubric.ts";

// Public synthetic development fixtures only. No real holdout bytes belong here.
const source = "Summarize this synthetic project plan.";
const rewrite = () => ({
  version: "one-shot-rubric-v1",
  expectedDirection: "rewrite_expected",
  preRegisteredReason: "Retain the requested project-plan summary.",
  counterexample: "A response that omits the project plan is wrong.",
  predicate: { kind: "literal_present", literal: "project plan" },
  passingFixture: "Summarize the project plan with clear sections.",
  failingFixture: "Summarize the budget with clear sections.",
});
const abstain = () => ({
  version: "one-shot-rubric-v1",
  expectedDirection: "abstain_preferred",
  preRegisteredReason: "The synthetic request is unsafe to rewrite.",
  counterexample: "A suggested rewrite would violate the safety direction.",
  predicate: { kind: "abstention_reason", reason: "unsafe_to_rewrite" },
  passingFixture: {
    outcome: "abstained", refinedPrompt: null,
    abstentionReason: "unsafe_to_rewrite",
  },
  failingFixture: {
    outcome: "suggested", refinedPrompt: "A distinct synthetic suggestion.",
    abstentionReason: null,
  },
});
const check = (rubric, direction = rubric.expectedDirection) =>
  validate(JSON.stringify(rubric), source, direction);

test("rewrite and abstention rubrics establish only structural fixture checks", () => {
  const expected = {
    rubricStructureValidated: true,
    fixtureSeparationValidated: true,
    semanticTruthVerified: false,
    independentAuthorshipVerified: false,
    dispatchAuthorized: false,
  };
  assert.deepEqual(check(rewrite()), expected);
  assert.deepEqual(check(abstain()), expected);
});

test("exact rubric shape, direction and explanation are required", () => {
  assert.throws(() => check({ ...rewrite(), extra: true }), /rubric_shape_invalid/);
  assert.throws(() => check({ ...rewrite(), preRegisteredReason: "short" }),
    /rubric_explanation_invalid/);
  assert.throws(() => check({ ...rewrite(), counterexample: rewrite().preRegisteredReason }),
    /rubric_counterexample_invalid/);
  assert.throws(() => check(rewrite(), "abstain_preferred"), /rubric_direction_invalid/);
});

test("rewrite fixtures must separate a closed deterministic predicate", () => {
  assert.throws(() => check({ ...rewrite(), failingFixture: rewrite().passingFixture }),
    /rubric_fixture_invalid/);
  assert.throws(() => check({ ...rewrite(), failingFixture: "project plan budget." }),
    /rubric_fixture_invalid/);
  assert.throws(() => check({ ...rewrite(), passingFixture: source }),
    /rubric_fixture_invalid/);
  assert.throws(() => check({ ...rewrite(), predicate: { kind: "script", source: "true" } }),
    /predicate_kind_invalid/);
});

test("abstention fixtures require the exact active reason and a wrong-direction example", () => {
  assert.throws(() => check({
    ...abstain(), predicate: { kind: "abstention_reason", reason: "no_material_improvement" },
  }), /rubric_predicate_invalid/);
  assert.throws(() => check({
    ...abstain(), failingFixture: abstain().passingFixture,
  }), /rubric_fixture_invalid/);
  assert.throws(() => check({
    ...abstain(), passingFixture: { ...abstain().passingFixture, refinedPrompt: "leak" },
  }), /rubric_fixture_invalid/);
});

test("bounded strict JSON rejects duplicate keys and oversized content", () => {
  assert.throws(() => validate(
    '{"version":"one-shot-rubric-v1","version":"one-shot-rubric-v1"}',
    source, "rewrite_expected"
  ), /rubric_json_invalid/);
  assert.throws(() => check({ ...rewrite(), counterexample: "x".repeat(4097) }),
    /rubric_explanation_invalid/);
  assert.throws(() => check({ ...rewrite(), passingFixture: "x".repeat(16385) }),
    /rubric_fixture_invalid/);
});
