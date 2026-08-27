import assert from "node:assert/strict";
import test from "node:test";
import {
  estimateRequestCredits,
  getWebSearchSurchargeCredits,
  modelEligibleForWebSearchSurcharge,
  WEB_SEARCH_SURCHARGE_CREDITS,
} from "../lib/webSearchCredits.ts";
import { getModel, MODEL_USAGE_CREDIT_WEIGHTS } from "../lib/models.ts";
import {
  getWebSearchCapability,
  NATIVE_GOOGLE_GROUNDING,
} from "../lib/webSearchCapability.ts";
import {
  ALL_WEB_SEARCH_BACKENDS_READY,
  NO_WEB_SEARCH_BACKENDS,
} from "../lib/webSearchBackends.ts";

test("the surcharge constant matches the shared credit weight table", () => {
  assert.equal(WEB_SEARCH_SURCHARGE_CREDITS, MODEL_USAGE_CREDIT_WEIGHTS.webSearchSurcharge);
  assert.equal(WEB_SEARCH_SURCHARGE_CREDITS, 8);
});

test("only native capability is eligible for the surcharge", () => {
  assert.equal(
    modelEligibleForWebSearchSurcharge({
      support: "native",
      hasAdditionalCost: true,
      maxBillableSearchQueriesPerRequest: 5,
    }),
    true
  );
  // Native, paid per query, no enforceable ceiling: undispatchable, so
  // unsurcharged.
  assert.equal(
    modelEligibleForWebSearchSurcharge({
      support: "native",
      hasAdditionalCost: true,
    }),
    false
  );
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
    backendReadiness: ALL_WEB_SEARCH_BACKENDS_READY,
    models: [getModel("gpt-5-5")],
    estimatedInputTokens: 100,
    webSearchMode: "off",
  });
  assert.equal(estimate.webSearchReservationCredits, 0);
  assert.equal(estimate.models[0].nativeSearchEligible, true);
});

test("auto mode: surcharge is 0 even for a native-supported model (never server-triggered)", () => {
  const estimate = estimateRequestCredits({
    backendReadiness: ALL_WEB_SEARCH_BACKENDS_READY,
    models: [getModel("gpt-5-5")],
    estimatedInputTokens: 100,
    webSearchMode: "auto",
  });
  assert.equal(estimate.webSearchReservationCredits, 0);
});

test("always mode + one native-supported model reserves 8 credits", () => {
  const estimate = estimateRequestCredits({
    backendReadiness: ALL_WEB_SEARCH_BACKENDS_READY,
    models: [getModel("gpt-5-5")],
    estimatedInputTokens: 100,
    webSearchMode: "always",
  });
  assert.equal(estimate.webSearchReservationCredits, 8);
  assert.equal(estimate.models[0].webSearchSurchargeCredits, 8);
});

test("always mode + three dispatchable native models reserves 24 credits total", () => {
  const estimate = estimateRequestCredits({
    backendReadiness: ALL_WEB_SEARCH_BACKENDS_READY,
    models: [
      getModel("gpt-5-5"),
      getModel("gpt-5-6-luna"),
      getModel("claude-sonnet-5"),
    ],
    estimatedInputTokens: 100,
    webSearchMode: "always",
  });
  assert.equal(estimate.webSearchReservationCredits, 24);
  assert.equal(estimate.models.every((m) => m.nativeSearchEligible), true);
});

test("an application-managed model is surcharged the same flat eight credits", () => {
  // Flat, and the same price whichever route runs the search. Charging more
  // because a model happens to search through a vendor this application pays
  // separately would make an entitlement out of an implementation detail.
  const estimate = estimateRequestCredits({
    backendReadiness: ALL_WEB_SEARCH_BACKENDS_READY,
    models: [getModel("gemini-3-6-flash")],
    estimatedInputTokens: 100,
    webSearchMode: "always",
  });
  assert.equal(estimate.webSearchReservationCredits, WEB_SEARCH_SURCHARGE_CREDITS);
  assert.equal(estimate.models[0].searchSurchargeEligible, true);
  // The deprecated alias still reads the right value, so a caller that has not
  // been updated is not silently told "no".
  assert.equal(estimate.models[0].nativeSearchEligible, true);
});

test("with no reachable backend the same model is not surcharged", () => {
  // Charging the surcharge would be charging for a search that is never going
  // to run, and `resolveAttemptSearchPath` reads the surcharge as proof the
  // search was paid for -- so it would also report a search path that does not
  // exist.
  const estimate = estimateRequestCredits({
    backendReadiness: NO_WEB_SEARCH_BACKENDS,
    models: [getModel("gemini-3-6-flash")],
    estimatedInputTokens: 100,
    webSearchMode: "always",
  });
  assert.equal(estimate.webSearchReservationCredits, 0);
  assert.equal(estimate.models[0].searchSurchargeEligible, false);
});

test("Google's own grounding would still not be surcharged", () => {
  // The rule the Gemini models used to exercise, asserted against the record
  // rather than against a model id -- otherwise it stopped being tested the day
  // the last model moved off grounding.
  assert.equal(
    modelEligibleForWebSearchSurcharge(
      NATIVE_GOOGLE_GROUNDING,
      ALL_WEB_SEARCH_BACKENDS_READY
    ),
    false
  );
});

test("always mode + an unsupported model reserves 0 for that model", () => {
  const estimate = estimateRequestCredits({
    backendReadiness: ALL_WEB_SEARCH_BACKENDS_READY,
    models: [getModel("codestral")],
    estimatedInputTokens: 100,
    webSearchMode: "always",
  });
  assert.equal(estimate.webSearchReservationCredits, 0);
  assert.equal(estimate.models[0].nativeSearchEligible, false);
});

test("always mode + Perplexity Sonar never adds the native surcharge", () => {
  const estimate = estimateRequestCredits({
    backendReadiness: ALL_WEB_SEARCH_BACKENDS_READY,
    models: [getModel("perplexity/sonar")],
    estimatedInputTokens: 100,
    webSearchMode: "always",
  });
  assert.equal(estimate.webSearchReservationCredits, 0);
  assert.equal(estimate.models[0].nativeSearchEligible, false);
  // Sonar's own base weight is untouched -- no double charge.
  assert.equal(estimate.models[0].weightedBaseCredits, 16);
});

test("always mode + Perplexity Deep Research never adds the native surcharge", () => {
  const estimate = estimateRequestCredits({
    backendReadiness: ALL_WEB_SEARCH_BACKENDS_READY,
    models: [getModel("perplexity/sonar-deep-research")],
    estimatedInputTokens: 100,
    webSearchMode: "always",
  });
  assert.equal(estimate.webSearchReservationCredits, 0);
  assert.equal(estimate.models[0].weightedBaseCredits, 16);
});

test("the input-length multiplier applies to base credits only, never to the surcharge", () => {
  const estimate = estimateRequestCredits({
    backendReadiness: ALL_WEB_SEARCH_BACKENDS_READY,
    models: [getModel("gpt-5-5")],
    // Above the 100,000-token threshold -> 3x multiplier.
    estimatedInputTokens: 150_000,
    webSearchMode: "always",
  });
  const entry = estimate.models[0];
  // gpt-5-5 base (16) * 3x = 48, plus a flat, unmultiplied 8-credit surcharge.
  assert.equal(entry.weightedBaseCredits, 48);
  assert.equal(entry.webSearchSurchargeCredits, 8);
  assert.equal(entry.totalCredits, 56);
});

test("the worked example from the spec: 1 + 4 + 16 base, +8 per searching model", () => {
  // Standard/advanced/premium native-search-eligible models, matching the
  // spec's 1 + 4 + 8 = 13 base example exactly.
  const models = [
    getModel("claude-haiku-4-5"), // standard = 1, native
    getModel("claude-sonnet-5"), // advanced = 4, native
    getModel("gpt-5-5"), // explicit weight = 16, native
  ];
  const estimate = estimateRequestCredits({
    backendReadiness: ALL_WEB_SEARCH_BACKENDS_READY,
    models,
    estimatedInputTokens: 100,
    webSearchMode: "always",
  });
  assert.equal(estimate.weightedBaseCredits, 1 + 4 + 16);
  assert.equal(estimate.webSearchReservationCredits, 24);
  assert.equal(estimate.totalEstimatedCredits, 21 + 24);
});
