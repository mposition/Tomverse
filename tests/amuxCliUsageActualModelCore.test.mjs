import assert from "node:assert/strict";
import test from "node:test";

import {
  AMUX_CLI_ACTUAL_MODEL_MULTIPLE,
  AMUX_CLI_ACTUAL_MODEL_UNKNOWN,
  classifyAmuxCliActualModel,
} from "../lib/amux/cliUsageActualModelCore.ts";

const counts = () => ({
  inputTokens: 10,
  outputTokens: 5,
  cacheReadInputTokens: 2,
  cacheCreationInputTokens: 1,
  reasoningOutputTokens: null,
});
const model = (modelId) => ({ modelId, observed: counts() });
const claude = (modelsJson, completeness = "reported_complete") => ({
  cli: "claude", completeness, modelsJson,
});

test("one attested Claude model keeps its actual id", () => {
  assert.equal(classifyAmuxCliActualModel(claude([model("claude-opus-5-5")])),
    "claude-opus-5-5");
});

test("multiple actual models count as one multi_model invocation", () => {
  assert.equal(classifyAmuxCliActualModel(claude([
    model("claude-opus-5-5"), model("claude-fable-5-1"),
  ])), AMUX_CLI_ACTUAL_MODEL_MULTIPLE);
  assert.equal(classifyAmuxCliActualModel(claude([
    model("claude-opus-5-5"), model("claude-fable-5-1"),
  ], "reported_partial")), AMUX_CLI_ACTUAL_MODEL_MULTIPLE);
});

test("unattested actual model never inherits the selected model", () => {
  assert.equal(classifyAmuxCliActualModel({
    cli: "codex", completeness: "reported_complete", modelsJson: [],
  }), AMUX_CLI_ACTUAL_MODEL_UNKNOWN);
  assert.equal(classifyAmuxCliActualModel(claude([], "reported_partial")),
    AMUX_CLI_ACTUAL_MODEL_UNKNOWN);
  assert.equal(classifyAmuxCliActualModel(claude([
    model("claude-opus-5-5"),
  ], "reported_partial")), AMUX_CLI_ACTUAL_MODEL_UNKNOWN);
  assert.equal(classifyAmuxCliActualModel(claude([], "unknown")),
    AMUX_CLI_ACTUAL_MODEL_UNKNOWN);
});

test("conflicting or invented model evidence fails closed", () => {
  assert.throws(() => classifyAmuxCliActualModel(claude([])), /lacks model evidence/);
  assert.throws(() => classifyAmuxCliActualModel({
    cli: "codex", completeness: "reported_complete",
    modelsJson: [model("gpt-6-sol")],
  }), /conflicts with receipt state/);
  assert.throws(() => classifyAmuxCliActualModel(claude([
    model("claude-opus-5-5"), model("claude-opus-5-5"),
  ])), /not attested/);
  assert.throws(() => classifyAmuxCliActualModel(claude([
    model("actualModelUnknown"),
  ])), /not attested/);
  assert.throws(() => classifyAmuxCliActualModel(claude([
    model("multi_model"),
  ])), /not attested/);
  assert.throws(() => classifyAmuxCliActualModel(claude([
    model("MULTI_MODEL"),
  ])), /not attested/);
  assert.throws(() => classifyAmuxCliActualModel(claude([
    { modelId: "claude-opus-5-5" },
  ])), /not attested/);
  assert.throws(() => classifyAmuxCliActualModel(claude([
    { ...model("claude-opus-5-5"), selectedModelId: "gpt-6-sol" },
  ])), /not attested/);
  assert.throws(() => classifyAmuxCliActualModel({
    cli: "claude", completeness: "unknown", modelsJson: [model("claude-opus-5-5")],
  }), /conflicts with receipt state/);
});
