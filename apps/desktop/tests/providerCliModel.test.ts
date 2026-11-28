import assert from "node:assert/strict";
import test from "node:test";
import { cliPermissionPlan, liveCliChoiceForModel, liveCliModelId, liveCliProviderForModel } from "../src/provider-cli-exec-contract";
import { claudeArguments, codexArguments } from "../src/host/provider-cli-exec";
import { codePickerModels, creditFreeModelIds } from "../src/code-model-catalog";

test("A composer id names the CLI and, optionally, the Tomverse catalogue model it runs", () => {
  assert.deepEqual(liveCliChoiceForModel(liveCliModelId("anthropic")), { provider: "anthropic" });
  assert.deepEqual(liveCliChoiceForModel(liveCliModelId("openai", "gpt-5-6-terra")), { provider: "openai", catalogueModelId: "gpt-5-6-terra" });
  assert.deepEqual(liveCliChoiceForModel("provider-cli:zai:glm-5.2"), { provider: "zai", catalogueModelId: "glm-5.2" });
  for (const id of ["gpt-5-6-terra", "provider-cli:openai:", "provider-cli:openai:--yolo", "provider-cli:openai:a b", "provider-cli:other:x"]) {
    assert.equal(liveCliChoiceForModel(id), null, id);
  }
  assert.equal(liveCliProviderForModel(liveCliModelId("openai", "gpt-5-6-sol")), "openai");
});

test("The chosen model reaches each CLI as one --model argument, and nothing that looks like an option does", () => {
  const codex = codexArguments({ cwd: "/work", plan: cliPermissionPlan("openai", "read_only"), model: "gpt-5.6-terra" });
  assert.deepEqual(codex.slice(codex.indexOf("--model"), codex.indexOf("--model") + 2), ["--model", "gpt-5.6-terra"]);
  assert.equal(codex.at(-1), "-", "the prompt still comes on stdin");
  const claude = claudeArguments({ plan: cliPermissionPlan("anthropic", "ask"), sessionId: "s", model: "claude-opus-5-5" });
  assert.deepEqual(claude.slice(-2), ["--model", "claude-opus-5-5"]);
  assert.ok(!codexArguments({ cwd: "/work", plan: cliPermissionPlan("openai", "read_only") }).includes("--model"), "no choice keeps the CLI default");
  for (const model of ["--dangerously-skip-permissions", "a b", "", "x".repeat(200)]) {
    assert.throws(() => claudeArguments({ plan: cliPermissionPlan("anthropic", "ask"), sessionId: "s", model }), model);
  }
});

test("A CLI's Tomverse models are named by the catalogue, with the CLI under them and no credit estimate", () => {
  const models = [{ id: liveCliModelId("anthropic", "claude-opus-5-5"), name: "Claude Opus 5.5", provider: "anthropic", efforts: [], via: "Claude Code" }];
  assert.equal(codePickerModels(models, "{size}")[0]!.bestFor, "Claude Code");
  assert.deepEqual(creditFreeModelIds(models), [models[0]!.id]);
});
