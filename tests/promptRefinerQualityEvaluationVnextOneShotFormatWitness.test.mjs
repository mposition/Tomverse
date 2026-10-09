import assert from "node:assert/strict";
import test from "node:test";
import { validatePromptRefinerVnextOneShotFormatWitness as validate } from
  "../lib/promptRefinerQualityEvaluationVnextOneShotFormatWitness.ts";

// Public synthetic format fixtures, never independent holdout items or labels.
const witness = () => ({
  version: "constrained-format-witness-v1",
  passingFixture: '{"title":"demo","count":2}',
  predicates: [
    { kind: "single_line" },
    { kind: "json_object_keys", keys: ["title", "count"] },
  ],
  failingFixtures: [
    { predicateIndex: 0, output: '{\n"title":"demo","count":2}' },
    { predicateIndex: 1, output: '{"title":"demo","count":2,"extra":true}' },
  ],
});

test("two independent structural predicates have passing and isolated failing fixtures", () => {
  assert.deepEqual(validate(witness()), {
    structuralPredicateCount: 2,
    syntheticFixtureChecksPassed: true,
    fullManifestValidated: false,
    rubricTruthVerified: false,
    dispatchAuthorized: false,
  });
});

test("a failure fixture that breaks both predicates is rejected", () => {
  const value = witness();
  value.failingFixtures[0].output = '{\n"title":"demo","extra":true}';
  assert.throws(() => validate(value), /failure_fixture_invalid/);
});

test("duplicate, missing or nonstructural predicates are rejected", () => {
  const duplicate = witness();
  duplicate.predicates[1] = { kind: "single_line" };
  assert.throws(() => validate(duplicate), /predicates_invalid/);
  const missing = witness();
  missing.predicates.pop();
  assert.throws(() => validate(missing), /contract_invalid/);
  const sparse = witness();
  sparse.predicates = [{ kind: "single_line" }];
  sparse.predicates.length = 2;
  assert.throws(() => validate(sparse), /format_witness_predicates_invalid/);
  const literal = witness();
  literal.predicates[0] = { kind: "literal_present", literal: "demo" };
  assert.throws(() => validate(literal), /predicates_invalid/);
});

test("failure fixtures must cover each predicate index exactly once", () => {
  const value = witness();
  value.failingFixtures[1].predicateIndex = 0;
  assert.throws(() => validate(value), /failure_index_invalid/);
  const unknown = witness();
  unknown.failingFixtures[0].predicateIndex = 2;
  assert.throws(() => validate(unknown), /failure_index_invalid/);
});

test("closed shapes and invalid or oversized fixture text fail closed", () => {
  const extra = { ...witness(), unexpected: true };
  assert.throws(() => validate(extra), /shape_invalid/);
  const nonStringPass = witness();
  nonStringPass.passingFixture = 42;
  assert.throws(() => validate(nonStringPass), /format_witness_pass_fixture_invalid/);
  const nonStringFailure = witness();
  nonStringFailure.failingFixtures[0].output = 42;
  assert.throws(() => validate(nonStringFailure), /format_witness_failure_fixture_invalid/);
  const bad = witness();
  bad.passingFixture = " ";
  assert.throws(() => validate(bad), /format_witness_pass_fixture_invalid/);
  const oversized = witness();
  oversized.failingFixtures[0].output = "x".repeat(16 * 1024 + 1);
  assert.throws(() => validate(oversized), /format_witness_failure_fixture_invalid/);
});
