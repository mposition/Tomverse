import assert from "node:assert/strict";
import test from "node:test";

import {
  SESSION_MODEL_SCOPE_DEFAULT, chooseSessionModel, sessionModelKey, sessionModelSelection,
} from "../lib/amux/ideaSessionModelChoiceCore.ts";

const models = [
  { approvalId: "approval-cursor", approvalVersion: 1, provider: "cursor",
    modelId: "grok-4.7-high", allowedEfforts: ["high", "medium"] },
  { approvalId: "approval-claude", approvalVersion: 2, provider: "anthropic",
    modelId: "claude-opus-5-5", allowedEfforts: ["max", "low", "xhigh"] },
];

test("the scope default sends no model, so the operating scope's model runs", () => {
  assert.equal(sessionModelSelection(models, SESSION_MODEL_SCOPE_DEFAULT), null);
  assert.equal(sessionModelSelection(null, SESSION_MODEL_SCOPE_DEFAULT), null);
});

test("picking a model starts at high when allowed, else its highest effort, and sends that exact selection", () => {
  const cursor = chooseSessionModel(models, sessionModelKey(models[0]));
  assert.deepEqual(cursor, { key: "cursor:grok-4.7-high", effort: "high" });
  assert.deepEqual(sessionModelSelection(models, cursor),
    { provider: "cursor", modelId: "grok-4.7-high", reasoningEffort: "high" });
  assert.deepEqual(chooseSessionModel(models, "anthropic:claude-opus-5-5"),
    { key: "anthropic:claude-opus-5-5", effort: "max" }, "no high: the highest, in any order");
  const withHigh = [{ ...models[1], allowedEfforts: ["max", "high", "ultra"] }];
  assert.deepEqual(chooseSessionModel(withHigh, "anthropic:claude-opus-5-5"),
    { key: "anthropic:claude-opus-5-5", effort: "high" },
    "high wins over max and ultra: the pinned Claude channel launches only high");
  assert.deepEqual(chooseSessionModel(models, ""), SESSION_MODEL_SCOPE_DEFAULT);
  assert.deepEqual(chooseSessionModel(models, "openai:gone"), SESSION_MODEL_SCOPE_DEFAULT);
});

test("an unlisted model or a disallowed effort closes the submit instead of falling back", () => {
  assert.equal(sessionModelSelection(models, { key: "cursor:grok-4.7-high", effort: "max" }), "incomplete");
  assert.equal(sessionModelSelection(models, { key: "openai:gone", effort: "high" }), "incomplete");
  assert.equal(sessionModelSelection(null, { key: "cursor:grok-4.7-high", effort: "high" }), "incomplete");
});
