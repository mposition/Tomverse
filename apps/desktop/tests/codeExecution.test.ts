import assert from "node:assert/strict";
import test from "node:test";
import { codeProviders, codeRouteFor, tomverseApiExecution } from "../src/code-execution";

test("Code classifies the approved CLI providers without treating registered providers as API models", () => {
  assert.deepEqual(Object.entries(codeProviders).filter(([, cli]) => cli !== null), [
    ["openai", "Codex"], ["anthropic", "Claude Code"], ["google", "Antigravity"], ["xai", "Grok Build"],
    ["qwen", "Qwen Code"], ["moonshot", "Kimi Code"], ["mistral", "Mistral Vibe"], ["minimax", "MiniMax Code"],
  ]);
  assert.deepEqual(Object.entries(codeProviders).filter(([, cli]) => cli === null).map(([provider]) => provider),
    ["deepseek", "zhipu", "cohere", "groq", "perplexity", "deepinfra", "together", "openrouter", "sail", "fal", "bfl", "byteplus", "recraft", "ideogram"]);
  assert.deepEqual(codeRouteFor("tomverse_api", undefined), { executionMode: null });
  assert.deepEqual(codeRouteFor("provider_cli", { id: "smart-adaptive", provider: "tomverse" }), { executionMode: null });
  assert.deepEqual(codeRouteFor("provider_cli", { id: "unexpected", provider: "constructor" }), { executionMode: null });
  assert.equal(codeRouteFor("tomverse_api", { id: "openai-model", provider: "openai" }), tomverseApiExecution);
  assert.deepEqual(codeRouteFor("provider_cli", { id: "openai-model", provider: "openai" }), { executionMode: "provider_cli", provider: "openai", cli: "Codex" });
  assert.equal(codeRouteFor("provider_cli", { id: "groq-model", provider: "groq" }), tomverseApiExecution);
  // DeepSeek and GLM have no official CLI here, so the provider CLI preference still runs them on the Tomverse API.
  assert.equal(codeRouteFor("provider_cli", { id: "deepseek-chat", provider: "deepseek" }), tomverseApiExecution);
  assert.equal(codeRouteFor("provider_cli", { id: "glm-chat", provider: "zhipu" }), tomverseApiExecution);
  assert.equal(codeRouteFor("tomverse_api", { id: "deepseek-chat", provider: "deepseek" }), tomverseApiExecution);
});
