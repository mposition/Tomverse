import assert from "node:assert/strict";
import test from "node:test";
import { getModelPickerSearchLabel } from "../lib/modelPickerPresentation.ts";
import { ALL_WEB_SEARCH_BACKENDS_READY as ready, NO_WEB_SEARCH_BACKENDS as unavailable } from "../lib/webSearchBackends.ts";

test("catalogue search labels distinguish provider-native and managed routes", () => {
  assert.equal(getModelPickerSearchLabel("gpt-5-6-luna", "en", ready), "Web search · OpenAI");
  assert.equal(getModelPickerSearchLabel("claude-sonnet-5", "en", ready), "Web search · Anthropic");
  assert.equal(getModelPickerSearchLabel("gpt-6-luna", "en", ready), "Web search · Tomverse (Brave)");
  assert.equal(getModelPickerSearchLabel("claude-haiku-5-5", "ko", ready), "웹 검색 · Tomverse (Brave)");
  assert.equal(getModelPickerSearchLabel("perplexity/sonar", "en", ready), "Web search · Perplexity");
});

test("runtime models and overrides show the resolved route, without promising unavailable search", () => {
  const model = { id: "new-openai-model", provider: "openai", apiModel: "new-api-model" };
  assert.equal(getModelPickerSearchLabel(model, "en", ready), "Web search · Tomverse (Brave)");
  assert.equal(getModelPickerSearchLabel(model, "en", unavailable), null);
  assert.equal(getModelPickerSearchLabel({ id: "claude-sonnet-5", provider: "anthropic", webSearchOverride: "app-managed" }, "en", ready), "Web search · Tomverse (Brave)");
  assert.equal(getModelPickerSearchLabel({ ...model, webSearchOverride: "off" }, "en", ready), null);
  assert.equal(getModelPickerSearchLabel("unknown-model", "en", ready), null);
});
