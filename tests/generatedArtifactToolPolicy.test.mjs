import assert from "node:assert/strict";
import test from "node:test";

import { ENABLED_MODELS } from "../lib/models.ts";
import { getWebSearchCapability } from "../lib/webSearchCapability.ts";
import {
  ARTIFACT_TOOL_CAPABILITIES,
  getArtifactToolSupport,
  nativeSearchBlocksArtifactTool,
  planGeneratedArtifactTool,
} from "../lib/generatedArtifactToolPolicy.ts";

// docs/policy/generated-artifacts.md sections 2, 7 and 10.

const plan = (overrides = {}) =>
  planGeneratedArtifactTool({
    modelId: "gpt-5-6-luna",
    provider: "openai",
    isAuthenticated: true,
    canPersist: true,
    nativeSearchEnabled: false,
    nativeSearchForced: false,
    conversationKind: "chat",
    ...overrides,
  });

/* -------------------------------------------------------------------------- */
/* The decision                                                                 */
/* -------------------------------------------------------------------------- */

test("a signed-in account on a verified model gets the tool", () => {
  const result = plan();
  assert.equal(result.mode, "generate");
  assert.equal(result.registerTool, true);
});

test("a guest gets the tool, and it refuses", () => {
  // Registered rather than omitted: the refusal is what draws the sign-in
  // card. Omitting it would leave the model free to answer with a table.
  const result = plan({ isAuthenticated: false });
  assert.equal(result.mode, "sign_in_required");
  assert.equal(result.registerTool, true);
});

test("an unverified model refuses out loud rather than silently", () => {
  const result = plan({ modelId: "grok-4-5", provider: "xai" });
  assert.equal(result.mode, "off");
  assert.equal(result.offReason, "model_unverified");
  assert.equal(result.registerTool, false);
});

test("a turn with nowhere to attach a file says so, and does not say 'sign in'", () => {
  const result = plan({ canPersist: false });
  assert.equal(result.mode, "off");
  assert.equal(result.offReason, "no_conversation");
  // A signed-in account being told to sign in is a dead end.
  assert.ok(!/sign(ed)? in/i.test(result.systemPrompt));
});

test("an image conversation is out of scope before anything else is considered", () => {
  const result = plan({ conversationKind: "image", isAuthenticated: false });
  assert.equal(result.mode, "off");
  assert.equal(result.offReason, "not_a_chat_conversation");
});

test("every plan carries a system block, including every refusal", () => {
  for (const overrides of [
    {},
    { isAuthenticated: false },
    { modelId: "grok-4-5", provider: "xai" },
    { canPersist: false },
    { conversationKind: "image" },
    { nativeSearchEnabled: true, nativeSearchForced: true },
  ]) {
    const result = plan(overrides);
    assert.ok(
      result.systemPrompt.trim().length > 0,
      JSON.stringify(overrides)
    );
  }
});

/* -------------------------------------------------------------------------- */
/* Web search coexistence                                                       */
/* -------------------------------------------------------------------------- */

test("a forced native search keeps the turn, and the file request is refused", () => {
  // `toolChoice: "required"` means "call *a* tool". A second tool would let
  // the model satisfy it without searching, so "always search" would quietly
  // stop meaning always.
  const result = plan({ nativeSearchEnabled: true, nativeSearchForced: true });
  assert.equal(result.mode, "off");
  assert.equal(result.offReason, "native_search_conflict");
  assert.match(result.systemPrompt, /web search/i);
});

test("Google grounding and function declarations are never sent together", () => {
  const result = plan({
    modelId: "gemini-3-6-flash",
    provider: "google",
    nativeSearchEnabled: true,
    nativeSearchForced: false,
  });
  assert.equal(result.mode, "off");
  assert.equal(result.offReason, "native_search_conflict");
});

test("Anthropic's web search coexists with the artifact tool", () => {
  const result = plan({
    modelId: "claude-sonnet-5",
    provider: "anthropic",
    nativeSearchEnabled: true,
    nativeSearchForced: false,
  });
  assert.equal(result.mode, "generate");
  assert.equal(result.registerTool, true);
});

test("search that is not running blocks nothing", () => {
  assert.equal(
    nativeSearchBlocksArtifactTool({
      provider: "google",
      nativeSearchEnabled: false,
      nativeSearchForced: true,
    }),
    false
  );
});

test("the forced-search rule reads the capability, not the provider name", () => {
  // OpenAI is the only provider whose native tool can be forced, and
  // lib/webSearchCapability.ts is where that is recorded. The two must not
  // drift into separate opinions.
  assert.equal(getWebSearchCapability("gpt-5-6-luna").canForceExecution, true);
  assert.equal(getWebSearchCapability("claude-sonnet-5").canForceExecution, false);
  assert.equal(getWebSearchCapability("gemini-3-6-flash").canForceExecution, false);
});

/* -------------------------------------------------------------------------- */
/* The instructions                                                             */
/* -------------------------------------------------------------------------- */

test("the generate prompt forbids every shape of a faked result", () => {
  const prompt = plan().systemPrompt;
  for (const forbidden of ["base64", "data URL", "file path", "download link"]) {
    assert.ok(prompt.includes(forbidden), forbidden);
  }
  assert.match(prompt, /Never substitute CSV/);
  assert.match(prompt, /not supported yet/);
});

test("the guest prompt refuses the same four substitutes", () => {
  const prompt = plan({ isAuthenticated: false }).systemPrompt;
  assert.match(prompt, /table/);
  assert.match(prompt, /CSV text/);
  assert.match(prompt, /base64/);
  assert.match(prompt, /link/);
});

test("an off prompt tells the user what would actually help", () => {
  assert.match(
    plan({ modelId: "grok-4-5", provider: "xai" }).systemPrompt,
    /different model/
  );
  assert.match(
    plan({ nativeSearchEnabled: true, nativeSearchForced: true }).systemPrompt,
    /web search off/
  );
});

/* -------------------------------------------------------------------------- */
/* The capability registry                                                      */
/* -------------------------------------------------------------------------- */

test("an unknown model is unverified rather than assumed to work", () => {
  assert.equal(getArtifactToolSupport("a-model-nobody-added"), "unverified");
});

test("every registered model is a real catalogue id", () => {
  // A typo here is silent: the model simply never gets the tool, and nothing
  // says so. Guarding it against the catalogue is what makes the registry a
  // claim rather than a wish.
  const catalogue = new Set(ENABLED_MODELS.map((model) => model.id));
  for (const modelId of Object.keys(ARTIFACT_TOOL_CAPABILITIES)) {
    assert.ok(catalogue.has(modelId), `${modelId} is not an enabled model`);
  }
});

test("Perplexity's models stay out of the registry", () => {
  // Their search models answer from a retrieval loop this app does not drive,
  // and the deep research model never reaches the streaming path at all.
  for (const modelId of Object.keys(ARTIFACT_TOOL_CAPABILITIES)) {
    assert.ok(!modelId.startsWith("perplexity/"), modelId);
  }
});
