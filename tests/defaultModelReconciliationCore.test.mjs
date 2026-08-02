import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_MAX_SELECTED_MODELS,
  rewriteDefaultModel,
  rewriteSelectedModels,
} from "../lib/defaultModelReconciliationCore.ts";

const FROM = "gpt-5-4-mini";
const TO = "gpt-5-6-luna";
const options = { from: FROM, to: TO };

test("rewriteDefaultModel replaces only an exact match", () => {
  assert.deepEqual(rewriteDefaultModel(FROM, options), {
    status: "rewritten",
    value: TO,
  });
  assert.deepEqual(rewriteDefaultModel("claude-haiku-4-5", options), {
    status: "unchanged",
  });
});

test("rewriteDefaultModel does not match on a prefix or substring", () => {
  // A future sibling id must not be swept up by the migration.
  assert.deepEqual(rewriteDefaultModel("gpt-5-4-mini-preview", options), {
    status: "unchanged",
  });
  assert.deepEqual(rewriteDefaultModel("legacy-gpt-5-4-mini", options), {
    status: "unchanged",
  });
});

test("rewriteDefaultModel is idempotent", () => {
  const first = rewriteDefaultModel(FROM, options);
  assert.equal(first.status, "rewritten");
  assert.deepEqual(rewriteDefaultModel(first.value, options), {
    status: "unchanged",
  });
});

test("rewriteSelectedModels replaces the retired id in place", () => {
  const result = rewriteSelectedModels(
    JSON.stringify(["claude-haiku-4-5", FROM, "gemini-2-5-flash"]),
    options
  );
  assert.equal(result.status, "rewritten");
  // Position preserved: the replacement sits where the old id sat.
  assert.deepEqual(result.models, [
    "claude-haiku-4-5",
    TO,
    "gemini-2-5-flash",
  ]);
  assert.equal(result.value, JSON.stringify(result.models));
  assert.equal(result.warning, undefined);
});

test("rewriteSelectedModels collapses a duplicate when the target is already selected", () => {
  const result = rewriteSelectedModels(
    JSON.stringify(["gemini-2-5-flash", FROM, TO]),
    options
  );
  assert.equal(result.status, "rewritten");
  assert.deepEqual(result.models, ["gemini-2-5-flash", TO]);
  // One entry, not two, and the surviving order of the other models holds.
  assert.equal(new Set(result.models).size, result.models.length);
});

test("rewriteSelectedModels keeps the first occurrence when the target precedes the old id", () => {
  const result = rewriteSelectedModels(
    JSON.stringify([TO, "claude-haiku-4-5", FROM]),
    options
  );
  assert.equal(result.status, "rewritten");
  assert.deepEqual(result.models, [TO, "claude-haiku-4-5"]);
});

test("rewriteSelectedModels leaves unrelated selections untouched", () => {
  const stored = JSON.stringify(["claude-haiku-4-5", "gemini-2-5-flash"]);
  assert.deepEqual(rewriteSelectedModels(stored, options), {
    status: "unchanged",
  });
});

test("rewriteSelectedModels never rewrites a lookalike id", () => {
  const stored = JSON.stringify(["gpt-5-4-mini-preview", "xgpt-5-4-mini"]);
  assert.deepEqual(rewriteSelectedModels(stored, options), {
    status: "unchanged",
  });
});

test("rewriteSelectedModels is idempotent", () => {
  const first = rewriteSelectedModels(
    JSON.stringify([FROM, "gemini-2-5-flash"]),
    options
  );
  assert.equal(first.status, "rewritten");
  assert.deepEqual(rewriteSelectedModels(first.value, options), {
    status: "unchanged",
  });
});

test("rewriteSelectedModels reports malformed values instead of destroying them", () => {
  for (const [stored, reason] of [
    ["not json at all", "not_valid_json"],
    ['{"models":["gpt-5-4-mini"]}', "not_a_json_array"],
    ['["gpt-5-4-mini", 42]', "contains_non_string_entry"],
    ['["gpt-5-4-mini", null]', "contains_non_string_entry"],
  ]) {
    const result = rewriteSelectedModels(stored, options);
    assert.equal(result.status, "malformed", stored);
    assert.equal(result.reason, reason, stored);
    // No `value` is produced, so the caller has nothing it could write back.
    assert.equal("value" in result, false, stored);
  }
});

test("rewriteSelectedModels can never grow a selection past the limit", () => {
  const stored = JSON.stringify([FROM, "claude-haiku-4-5", "gemini-2-5-flash"]);
  const result = rewriteSelectedModels(stored, options);
  assert.equal(result.status, "rewritten");
  assert.ok(result.models.length <= DEFAULT_MAX_SELECTED_MODELS);
  assert.equal(result.warning, undefined);
});

test("rewriteSelectedModels warns rather than truncating an already over-limit selection", () => {
  const stored = JSON.stringify([
    FROM,
    "claude-haiku-4-5",
    "gemini-2-5-flash",
    "mistral-small-4",
  ]);
  const result = rewriteSelectedModels(stored, options);
  assert.equal(result.status, "rewritten");
  // Length is preserved -- trimming someone's selection is a different
  // decision from this migration and must not happen as a side effect.
  assert.equal(result.models.length, 4);
  assert.match(result.warning ?? "", /above the limit/);
});

test("rewriteSelectedModels honours an explicit selection limit", () => {
  const result = rewriteSelectedModels(
    JSON.stringify([FROM, "claude-haiku-4-5"]),
    { ...options, maxSelectedModels: 1 }
  );
  assert.equal(result.status, "rewritten");
  assert.match(result.warning ?? "", /above the limit of 1/);
});
