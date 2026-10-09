import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluatePromptRefinerVnextOneShotPredicate as evaluate,
  validatePromptRefinerVnextOneShotPredicate as validate,
} from "../lib/promptRefinerQualityEvaluationVnextOneShotPredicateCore.ts";

// Every fixture below is public and synthetic; none is an independent holdout.
test("literal atoms check exact inclusion without normalizing away a boundary", () => {
  assert.equal(evaluate({ kind: "literal_present", literal: "exact 12" }, "keep exact 12"), true);
  assert.equal(evaluate({ kind: "literal_present", literal: "exact 12" }, "keep exact 13"), false);
  assert.equal(evaluate({ kind: "literal_absent", literal: "tool call" }, "rewrite only"), true);
  assert.equal(evaluate({ kind: "literal_absent", literal: "tool call" }, "make tool call"), false);
});

test("bounded structural atoms check line and exact JSON object keys", () => {
  assert.equal(evaluate({ kind: "single_line" }, "one line"), true);
  assert.equal(evaluate({ kind: "single_line" }, "line one\u2028line two"), false);
  const shape = { kind: "json_object_keys", keys: ["title", "count"] };
  assert.equal(evaluate(shape, '{"count":2,"title":"demo"}'), true);
  assert.equal(evaluate(shape, '{"count":2,"title":"demo","extra":true}'), false);
  assert.equal(evaluate(shape, '{"count":2,"title":"demo","count":3}'), false);
  assert.equal(evaluate(shape, '[1,2]'), false);
  assert.equal(evaluate(shape, "not json"), false);
});

test("unknown or executable-like predicate shapes fail closed", () => {
  for (const candidate of [
    null,
    [],
    "single_line",
    {},
    { kind: "regex", source: ".*" },
    { kind: "script", code: "return true" },
    { kind: "literal_present", literal: "x", extra: true },
    { kind: "single_line", call: "provider" },
    { kind: "json_object_keys", keys: ["x", "x"] },
    { kind: "json_object_keys", keys: ["__proto__"] },
  ]) assert.throws(() => validate(candidate), /vnext_one_shot_predicate_/);
});

test("atoms and outputs have explicit size and empty-value limits", () => {
  assert.throws(() => validate({ kind: "literal_present", literal: "x".repeat(513) }), /literal_invalid/);
  assert.throws(() => evaluate({ kind: "single_line" }, " "), /output_invalid/);
  assert.throws(() => evaluate({ kind: "single_line" }, "x".repeat(16 * 1024 + 1)), /output_invalid/);
  assert.throws(() => validate({ kind: "json_object_keys", keys: Array.from({ length: 17 }, (_, i) => `k${i}`) }), /keys_invalid/);
  assert.throws(() => validate({ kind: "json_object_keys", keys: ["a".repeat(65)] }), /keys_invalid/);
  assert.deepEqual(validate({ kind: "json_object_keys", keys: ["one"] }),
    { kind: "json_object_keys", keys: ["one"] });
});
