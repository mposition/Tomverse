import assert from "node:assert/strict";
import test from "node:test";
import {
  buildWebSearchToolConfig,
  WEB_SEARCH_TOOL_NAMES,
} from "../lib/webSearchToolConfig.ts";
import {
  getWebSearchCapability,
  NATIVE_GOOGLE_GROUNDING,
} from "../lib/webSearchCapability.ts";
import {
  APP_MANAGED_WEB_SEARCH_TOOL_NAME,
  buildAppManagedWebSearchTool,
} from "../lib/appManagedWebSearchTool.ts";

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

test("Google's grounding is never built, for any Google capability", () => {
  // Not "the catalogue no longer asks for it" -- the builder itself refuses.
  // Grounding takes no ceiling on the tool or on the request, so a request
  // carrying it has no worst case to reserve; and on Gemini a built-in
  // retrieval tool is exclusive with the function declarations this product now
  // searches and writes files with. There is no configuration in which emitting
  // it is right, so no code path emits it.
  assert.equal(buildWebSearchToolConfig(NATIVE_GOOGLE_GROUNDING), null);
  // The catalogue's own Google models are application-managed, so they are not
  // native at all and produce no native configuration either.
  assert.equal(
    buildWebSearchToolConfig(getWebSearchCapability("gemini-3-6-flash")),
    null
  );
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
  ]) {
    const capability = getWebSearchCapability(modelId);
    const config = buildWebSearchToolConfig(capability);
    assert.ok(config.tools[toolKey]);
    assert.equal(WEB_SEARCH_TOOL_NAMES[capability.provider], toolKey);
  }
  // The Google row stays in the map and stays untested against a built config,
  // because there is no built config: the name is what a *grounding* tool would
  // be called, and the entry is kept so the map still describes every value
  // `WebSearchCapability["provider"]` can hold.
});

test("the application-managed tool is a plain function declaration named web_search", () => {
  const { tools, session } = buildAppManagedWebSearchTool({
    backend: "brave",
    maxQueries: 5,
  });
  assert.deepEqual(Object.keys(tools), [APP_MANAGED_WEB_SEARCH_TOOL_NAME]);
  assert.equal(APP_MANAGED_WEB_SEARCH_TOOL_NAME, "web_search");
  // It cannot collide with the artifact tools, which are the five create_*
  // names, and it never shares a turn with a native search tool -- a model's
  // capability is one route or the other.
  assert.equal(session.maxQueries, 5);
  assert.equal(session.remaining(), 5);
});
