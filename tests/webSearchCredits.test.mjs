import assert from "node:assert/strict";
import test from "node:test";
import {
  estimateRequestCredits,
  getWebSearchSurchargeCredits,
  modelEligibleForWebSearchSurcharge,
  WEB_SEARCH_SURCHARGE_CREDITS,
} from "../lib/webSearchCredits.ts";
import { getModel, MODEL_USAGE_CREDIT_WEIGHTS } from "../lib/models.ts";
import { getWebSearchCapability } from "../lib/webSearchCapability.ts";

test("the surcharge constant matches the shared credit weight table", () => {
  assert.equal(WEB_SEARCH_SURCHARGE_CREDITS, MODEL_USAGE_CREDIT_WEIGHTS.webSearchSurcharge);
  assert.equal(WEB_SEARCH_SURCHARGE_CREDITS, 8);
});

test("only native capability is eligible for the surcharge", () => {
  assert.equal(modelEligibleForWebSearchSurcharge({ support: "native" }), true);
  assert.equal(modelEligibleForWebSearchSurcharge({ support: "search-model" }), false);
  assert.equal(modelEligibleForWebSearchSurcharge({ support: "unverified" }), false);
  assert.equal(modelEligibleForWebSearchSurcharge({ support: "unsupported" }), false);
});

test("getWebSearchSurchargeCredits only charges for always + native", () => {
  const native = getWebSearchCapability("gpt-5-5");
  const searchModel = getWebSearchCapability("perplexity/sonar");
  const unsupported = getWebSearchCapability("codestral");

  assert.equal(getWebSearchSurchargeCredits("off", native), 0);
  assert.equal(getWebSearchSurchargeCredits("auto", native), 0);
  assert.equal(getWebSearchSurchargeCredits("always", native), 8);
  assert.equal(getWebSearchSurchargeCredits("always", searchModel), 0);
  assert.equal(getWebSearchSurchargeCredits("always", unsupported), 0);
});

test("off mode: surcharge is 0 for a native-supported model", () => {
  const estimate = estimateRequestCredits({
    models: [getModel("gpt-5-5")],
    estimatedInputTokens: 100,
    webSearchMode: "off",
  });
  assert.equal(estimate.webSearchReservationCredits, 0);
  assert.equal(estimate.models[0].nativeSearchEligible, true);
});

test("auto mode: surcharge is 0 even for a native-supported model (never server-triggered)", () => {
  const estimate = estimateRequestCredits({
    models: [getModel("gpt-5-5")],
    estimatedInputTokens: 100,
    webSearchMode: "auto",
  });
  assert.equal(estimate.webSearchReservationCredits, 0);
});

test("always mode + one native-supported model reserves 8 credits", () => {
  const estimate = estimateRequestCredits({
    models: [getModel("gpt-5-5")],
    estimatedInputTokens: 100,
    webSearchMode: "always",
  });
  assert.equal(estimate.webSearchReservationCredits, 8);
  assert.equal(estimate.models[0].webSearchSurchargeCredits, 8);
});

test("always mode + three native-supported models reserves 24 credits total", () => {
  const estimate = estimateRequestCredits({
    models: [getModel("gpt-5-5"), getModel("claude-sonnet-5"), getModel("gemini-3-5-flash")],
    estimatedInputTokens: 100,
    webSearchMode: "always",
  });
  assert.equal(estimate.webSearchReservationCredits, 24);
  assert.equal(estimate.models.every((m) => m.nativeSearchEligible), true);
});

test("always mode + an unsupported model reserves 0 for that model", () => {
  const estimate = estimateRequestCredits({
    models: [getModel("codestral")],
    estimatedInputTokens: 100,
    webSearchMode: "always",
  });
  assert.equal(estimate.webSearchReservationCredits, 0);
  assert.equal(estimate.models[0].nativeSearchEligible, false);
});

test("always mode + Perplexity Sonar never adds the native surcharge", () => {
  const estimate = estimateRequestCredits({
    models: [getModel("perplexity/sonar")],
    estimatedInputTokens: 100,
    webSearchMode: "always",
  });
  assert.equal(estimate.webSearchReservationCredits, 0);
  assert.equal(estimate.models[0].nativeSearchEligible, false);
  // The research base weight (20) is untouched -- no double charge.
  assert.equal(estimate.models[0].weightedBaseCredits, 20);
});

test("always mode + Perplexity Deep Research never adds the native surcharge", () => {
  const estimate = estimateRequestCredits({
    models: [getModel("perplexity/sonar-deep-research")],
    estimatedInputTokens: 100,
    webSearchMode: "always",
  });
  assert.equal(estimate.webSearchReservationCredits, 0);
  assert.equal(estimate.models[0].weightedBaseCredits, 30);
});

test("the input-length multiplier applies to base credits only, never to the surcharge", () => {
  const estimate = estimateRequestCredits({
    models: [getModel("gpt-5-5")],
    // Above the 100,000-token threshold -> 3x multiplier.
    estimatedInputTokens: 150_000,
    webSearchMode: "always",
  });
  const entry = estimate.models[0];
  // Premium base (8) * 3x = 24, plus a flat, unmultiplied 8-credit surcharge.
  assert.equal(entry.weightedBaseCredits, 24);
  assert.equal(entry.webSearchSurchargeCredits, 8);
  assert.equal(entry.totalCredits, 32);
});

test("the worked example from the spec: 1 + 4 + 8 base, +8 per searching model", () => {
  // Standard/advanced/premium native-search-eligible models, matching the
  // spec's 1 + 4 + 8 = 13 base example exactly.
  const models = [
    getModel("claude-haiku-4-5"), // standard = 1, native
    getModel("claude-sonnet-5"), // advanced = 4, native
    getModel("gpt-5-5"), // premium = 8, native
  ];
  const estimate = estimateRequestCredits({
    models,
    estimatedInputTokens: 100,
    webSearchMode: "always",
  });
  assert.equal(estimate.weightedBaseCredits, 1 + 4 + 8);
  assert.equal(estimate.webSearchReservationCredits, 24);
  assert.equal(estimate.totalEstimatedCredits, 13 + 24);
});
