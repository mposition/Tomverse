import assert from "node:assert/strict";
import test from "node:test";
import { deriveWebSearchComposerState } from "../lib/webSearchComposerState.ts";
import { WEB_SEARCH_SURCHARGE_CREDITS } from "../lib/webSearchCredits.ts";
import { getWebSearchCapability } from "../lib/webSearchCapability.ts";

// Picked from the capability registry rather than hard-coded assumptions, so
// the test keeps meaning if a model's verified support changes.
const NATIVE = "gpt-5-5";
const UNSUPPORTED = "gpt-5-4-mini";

test("the fixtures still have the support this suite depends on", () => {
  assert.equal(getWebSearchCapability(NATIVE).support, "native");
  assert.equal(
    ["native", "search-model"].includes(getWebSearchCapability(UNSUPPORTED).support),
    false
  );
});

test("web search off hides the chip entirely", () => {
  const state = deriveWebSearchComposerState({
    webSearchMode: "off",
    selectedModelIds: [NATIVE, UNSUPPORTED],
  });
  assert.equal(state.isVisible, false);
  assert.equal(state.hasException, false);
  assert.equal(state.estimatedSurchargeCredits, 0);
});

test("full support produces a neutral chip with no exception row", () => {
  const state = deriveWebSearchComposerState({
    webSearchMode: "always",
    selectedModelIds: [NATIVE],
  });
  assert.equal(state.isVisible, true);
  assert.equal(state.supportedCount, 1);
  assert.equal(state.unsupportedCount, 0);
  assert.equal(state.hasException, false);
  assert.equal(state.tone, "neutral");
  assert.equal(state.allUnsupported, false);
  assert.equal(state.estimatedSurchargeCredits, WEB_SEARCH_SURCHARGE_CREDITS);
});

test("partial support is the only case that earns a visible exception", () => {
  const state = deriveWebSearchComposerState({
    webSearchMode: "always",
    selectedModelIds: [NATIVE, UNSUPPORTED, UNSUPPORTED],
  });
  assert.equal(state.supportedCount, 1);
  assert.equal(state.unsupportedCount, 2);
  assert.deepEqual(state.unsupportedModelIds, [UNSUPPORTED, UNSUPPORTED]);
  assert.equal(state.hasException, true);
  assert.equal(state.tone, "warning");
  assert.equal(state.allUnsupported, false);
  assert.equal(state.estimatedSurchargeCredits, WEB_SEARCH_SURCHARGE_CREDITS);
});

test("no supported model at all blocks rather than silently falling back", () => {
  const state = deriveWebSearchComposerState({
    webSearchMode: "always",
    selectedModelIds: [UNSUPPORTED, UNSUPPORTED],
  });
  assert.equal(state.supportedCount, 0);
  assert.equal(state.allUnsupported, true);
  assert.equal(state.tone, "blocked");
  assert.equal(state.estimatedSurchargeCredits, 0);
});

test("auto mode never reserves credits and never blocks on support", () => {
  const state = deriveWebSearchComposerState({
    webSearchMode: "auto",
    selectedModelIds: [UNSUPPORTED, UNSUPPORTED],
  });
  assert.equal(state.isVisible, true);
  assert.equal(state.hasException, false);
  assert.equal(state.allUnsupported, false);
  assert.equal(state.tone, "neutral");
  assert.equal(state.estimatedSurchargeCredits, 0);
});

test("the surcharge estimate tracks the selection, one charge per native model", () => {
  const one = deriveWebSearchComposerState({
    webSearchMode: "always",
    selectedModelIds: [NATIVE],
  });
  const two = deriveWebSearchComposerState({
    webSearchMode: "always",
    selectedModelIds: [NATIVE, NATIVE],
  });
  assert.equal(two.estimatedSurchargeCredits, one.estimatedSurchargeCredits * 2);
});
