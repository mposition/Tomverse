import assert from "node:assert/strict";
import test from "node:test";
import {
  buildWebSearchToolConfig,
  WEB_SEARCH_TOOL_NAMES,
} from "../lib/webSearchToolConfig.ts";
import { getWebSearchCapability } from "../lib/webSearchCapability.ts";

test("OpenAI native capability forces the tool via toolChoice: required", () => {
  const config = buildWebSearchToolConfig(getWebSearchCapability("gpt-5-5"));
  assert.ok(config);
  assert.equal(config.toolChoice, "required");
  assert.ok(config.tools.web_search, "expected a web_search tool entry");
  assert.equal(Object.keys(config.tools).length, 1);
});

test("Anthropic native capability offers the tool without forcing it", () => {
  const config = buildWebSearchToolConfig(
    getWebSearchCapability("claude-sonnet-5")
  );
  assert.ok(config);
  assert.equal(config.toolChoice, undefined);
  assert.ok(config.tools.web_search, "expected a web_search tool entry");
});

test("Google native capability offers google_search without forcing it", () => {
  const config = buildWebSearchToolConfig(
    getWebSearchCapability("gemini-3-5-flash")
  );
  assert.ok(config);
  assert.equal(config.toolChoice, undefined);
  assert.ok(config.tools.google_search, "expected a google_search tool entry");
});

test("non-native capabilities never produce a tool config", () => {
  assert.equal(
    buildWebSearchToolConfig(getWebSearchCapability("perplexity/sonar")),
    null
  );
  assert.equal(
    buildWebSearchToolConfig(getWebSearchCapability("gpt-5-4-mini")),
    null
  );
  assert.equal(
    buildWebSearchToolConfig(getWebSearchCapability("codestral")),
    null
  );
});

test("WEB_SEARCH_TOOL_NAMES matches the actual tool keys built for each provider", () => {
  assert.equal(WEB_SEARCH_TOOL_NAMES.openai, "web_search");
  assert.equal(WEB_SEARCH_TOOL_NAMES.anthropic, "web_search");
  assert.equal(WEB_SEARCH_TOOL_NAMES.google, "google_search");

  for (const [modelId, toolKey] of [
    ["gpt-5-5", "web_search"],
    ["claude-sonnet-5", "web_search"],
    ["gemini-3-5-flash", "google_search"],
  ]) {
    const capability = getWebSearchCapability(modelId);
    const config = buildWebSearchToolConfig(capability);
    assert.ok(config.tools[toolKey]);
    assert.equal(WEB_SEARCH_TOOL_NAMES[capability.provider], toolKey);
  }
});
