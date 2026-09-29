import assert from "node:assert/strict";
import test from "node:test";
import { getModel } from "../lib/models.ts";
import { deriveWebSearchComposerState } from "../lib/webSearchComposerState.ts";
import {
  estimateRequestCredits,
  WEB_SEARCH_SURCHARGE_CREDITS,
} from "../lib/webSearchCredits.ts";
import { getWebSearchCapability } from "../lib/webSearchCapability.ts";
import {
  ALL_WEB_SEARCH_BACKENDS_READY,
  NO_WEB_SEARCH_BACKENDS,
} from "../lib/webSearchBackends.ts";

// A model whose search this application runs itself, against a backend. Its
// support is a property of the register; whether it can search here is a
// property of this deployment, and the two are asserted apart below.
const APP_MANAGED = "gemini-3-7-flash";

// Picked from the capability registry rather than hard-coded assumptions, so
// the test keeps meaning if a model's verified support changes.
const NATIVE = "gpt-5-5";
// Deep research runs through its own flow and never takes the search switch.
// Every chat model can search by one route or another, so this is the one
// catalogue model left that genuinely cannot.
const UNSUPPORTED = "perplexity/sonar-deep-research";

test("the fixtures still have the support this suite depends on", () => {
  assert.equal(getWebSearchCapability(NATIVE).support, "native");
  assert.equal(
    ["native", "search-model"].includes(getWebSearchCapability(UNSUPPORTED).support),
    false
  );
});

test("web search off hides the chip entirely", () => {
  const state = deriveWebSearchComposerState({
    resolveModel: getModel,
    backendReadiness: ALL_WEB_SEARCH_BACKENDS_READY,
    webSearchMode: "off",
    selectedModelIds: [NATIVE, UNSUPPORTED],
  });
  assert.equal(state.isVisible, false);
  assert.equal(state.hasException, false);
  assert.equal(state.estimatedSurchargeCredits, 0);
});

test("full support produces a neutral chip with no exception row", () => {
  const state = deriveWebSearchComposerState({
    resolveModel: getModel,
    backendReadiness: ALL_WEB_SEARCH_BACKENDS_READY,
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
    resolveModel: getModel,
    backendReadiness: ALL_WEB_SEARCH_BACKENDS_READY,
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
    resolveModel: getModel,
    backendReadiness: ALL_WEB_SEARCH_BACKENDS_READY,
    webSearchMode: "always",
    selectedModelIds: [UNSUPPORTED, UNSUPPORTED],
  });
  assert.equal(state.supportedCount, 0);
  assert.equal(state.allUnsupported, true);
  assert.equal(state.tone, "blocked");
  assert.equal(state.estimatedSurchargeCredits, 0);
});

// The retired "auto" mode. A row saved before web search became a switch can
// still carry it, and it has to read as off everywhere the composer looks --
// no chip, no exception row, and above all no credit ceiling for a search this
// account never agreed to run unprompted.
test("a stored auto mode reads exactly like off", () => {
  const auto = deriveWebSearchComposerState({
    resolveModel: getModel,
    backendReadiness: ALL_WEB_SEARCH_BACKENDS_READY,
    webSearchMode: "auto",
    selectedModelIds: [NATIVE, UNSUPPORTED],
  });
  const off = deriveWebSearchComposerState({
    resolveModel: getModel,
    backendReadiness: ALL_WEB_SEARCH_BACKENDS_READY,
    webSearchMode: "off",
    selectedModelIds: [NATIVE, UNSUPPORTED],
  });
  assert.deepEqual(auto, off);
  assert.equal(auto.mode, "off");
  assert.equal(auto.isVisible, false);
  assert.equal(auto.estimatedSurchargeCredits, 0);
});

test("a stored always mode stays on", () => {
  const state = deriveWebSearchComposerState({
    resolveModel: getModel,
    backendReadiness: ALL_WEB_SEARCH_BACKENDS_READY,
    webSearchMode: "always",
    selectedModelIds: [NATIVE],
  });
  assert.equal(state.mode, "always");
  assert.equal(state.isVisible, true);
  assert.equal(state.estimatedSurchargeCredits, WEB_SEARCH_SURCHARGE_CREDITS);
});

test("the surcharge estimate tracks the selection, one charge per native model", () => {
  const one = deriveWebSearchComposerState({
    resolveModel: getModel,
    backendReadiness: ALL_WEB_SEARCH_BACKENDS_READY,
    webSearchMode: "always",
    selectedModelIds: [NATIVE],
  });
  const two = deriveWebSearchComposerState({
    resolveModel: getModel,
    backendReadiness: ALL_WEB_SEARCH_BACKENDS_READY,
    webSearchMode: "always",
    selectedModelIds: [NATIVE, NATIVE],
  });
  assert.equal(two.estimatedSurchargeCredits, one.estimatedSurchargeCredits * 2);
});

test("an application-managed model counts as search-ready when its backend is reachable", () => {
  const state = deriveWebSearchComposerState({
    resolveModel: getModel,
    backendReadiness: ALL_WEB_SEARCH_BACKENDS_READY,
    webSearchMode: "always",
    selectedModelIds: [APP_MANAGED],
  });
  assert.equal(state.supportedCount, 1);
  assert.equal(state.unsupportedCount, 0);
  assert.equal(state.hasException, false);
  assert.equal(state.tone, "neutral");
  assert.equal(state.estimatedSurchargeCredits, WEB_SEARCH_SURCHARGE_CREDITS);
});

test("a Google-only selection is not blocked", () => {
  // The contract this whole feature exists for: selecting only Google models
  // must not produce the "no selected model can search the web" notice.
  const state = deriveWebSearchComposerState({
    resolveModel: getModel,
    backendReadiness: ALL_WEB_SEARCH_BACKENDS_READY,
    webSearchMode: "always",
    selectedModelIds: [
      "gemini-3-7-flash",
      "gemini-3-6-flash",
      "gemini-3-1-pro",
      "gemini-2-5-flash",
    ],
  });
  assert.equal(state.allUnsupported, false);
  assert.equal(state.supportedCount, 4);
  assert.equal(state.tone, "neutral");
  assert.equal(state.estimatedSurchargeCredits, WEB_SEARCH_SURCHARGE_CREDITS * 4);
});

test("a mixed selection counts each route's models correctly", () => {
  const state = deriveWebSearchComposerState({
    resolveModel: getModel,
    backendReadiness: ALL_WEB_SEARCH_BACKENDS_READY,
    webSearchMode: "always",
    selectedModelIds: [NATIVE, APP_MANAGED, UNSUPPORTED],
  });
  assert.equal(state.supportedCount, 2);
  assert.equal(state.unsupportedCount, 1);
  assert.deepEqual(state.unsupportedModelIds, [UNSUPPORTED]);
  assert.equal(state.tone, "warning");
  assert.equal(state.estimatedSurchargeCredits, WEB_SEARCH_SURCHARGE_CREDITS * 2);
});

test("with no reachable backend the same selection is blocked, and quotes nothing", () => {
  const state = deriveWebSearchComposerState({
    resolveModel: getModel,
    backendReadiness: NO_WEB_SEARCH_BACKENDS,
    webSearchMode: "always",
    selectedModelIds: [APP_MANAGED],
  });
  assert.equal(state.supportedCount, 0);
  assert.equal(state.allUnsupported, true);
  assert.equal(state.tone, "blocked");
  // Never a price for a search that cannot run.
  assert.equal(state.estimatedSurchargeCredits, 0);
});

// A model adopted through the Provider Model Catalogue exists only as a
// registry row: its id is in no compiled table. Production, 2026-09-29: "GPT 6
// Luna" (`gpt-6-luna`) showed "Web search unavailable" beside a 9-credit
// estimate, because the chip resolved the id alone while the estimate held the
// row. The chip now resolves through the runtime catalogue, and both answers
// come from the same row.
test("a registry-only model is resolved through the runtime catalogue", () => {
  const row = {
    id: "gpt-6-luna",
    name: "GPT 6 Luna",
    provider: "openai",
    icon: "",
    bestFor: "",
    minimumPlan: "Guest",
    usageClass: "standard",
    enabled: true,
    status: "enabled",
  };
  const runtimeCatalogue = new Map([[row.id, row]]);
  const resolveModel = (modelId) => runtimeCatalogue.get(modelId) ?? getModel(modelId);

  const state = deriveWebSearchComposerState({
    resolveModel,
    backendReadiness: ALL_WEB_SEARCH_BACKENDS_READY,
    webSearchMode: "always",
    selectedModelIds: [row.id],
  });
  assert.equal(state.tone, "neutral");
  assert.equal(state.allUnsupported, false);
  assert.equal(state.supportedCount, 1);

  const estimate = estimateRequestCredits({
    backendReadiness: ALL_WEB_SEARCH_BACKENDS_READY,
    models: [row],
    estimatedInputTokens: 100,
    webSearchMode: "always",
  });
  assert.equal(
    state.estimatedSurchargeCredits,
    estimate.webSearchReservationCredits,
    "the chip and the estimate must price the same search"
  );

  // Without a reachable backend the same row is honestly unavailable in both.
  const offline = deriveWebSearchComposerState({
    resolveModel,
    backendReadiness: NO_WEB_SEARCH_BACKENDS,
    webSearchMode: "always",
    selectedModelIds: [row.id],
  });
  assert.equal(offline.allUnsupported, true);
  assert.equal(offline.estimatedSurchargeCredits, 0);
});
