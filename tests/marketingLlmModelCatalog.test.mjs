import assert from "node:assert/strict";
import test from "node:test";

import {
  MARKETING_LLM_MAX_OUTPUT_TOKENS,
  MARKETING_LLM_WEB_SEARCH_CALLS,
  MARKETING_LLM_WEB_SEARCH_PROFILE,
  MARKETING_OPENAI_SEARCH_OVERSHOOT_ALLOWANCE,
  MARKETING_OPENAI_WEB_SEARCH_MICRO_USD_PER_CALL,
  marketingLlmPinAllows,
  marketingLlmPinProblems,
  marketingLlmReservation,
} from "@/lib/marketingLlmBudgetCore";
import { marketingLlmModelOptionsFrom } from "@/lib/marketingLlmModelCatalog";
import { MODEL_PRICING } from "@/lib/modelPricing";
import { AVAILABLE_MODELS } from "@/lib/models";
import { OPENAI_SEARCH_OVERSHOOT_ALLOWANCE } from "@/lib/webSearchCapability";

const options = marketingLlmModelOptionsFrom(AVAILABLE_MODELS);
const option = (model) => options.find((entry) => entry.model === model);

test("every enabled catalog model is listed once, and only OpenAI can be selected", () => {
  const ids = options.map((entry) => entry.model);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(
    [...ids].sort(),
    [...new Set(AVAILABLE_MODELS.filter((model) => model.enabled).map((model) => model.apiModel))].sort(),
  );
  for (const entry of options) {
    if (entry.provider !== "openai") {
      assert.equal(entry.unavailable, "provider_not_supported", entry.model);
      assert.equal(entry.pin, null);
    }
  }
});

test("a pin is the catalog price at its worst, with the generator's own caps and OpenAI's search price", () => {
  for (const { pin, model } of options.filter((entry) => entry.pin)) {
    const profiles = MODEL_PRICING.filter((profile) => profile.apiModelId === model);
    const rates = profiles.flatMap((profile) => [profile.tiers, ...(profile.priceSchedule ?? []).map((r) => r.tiers)].flat());
    assert.ok(pin.worstInputMicroUsdPerMillion >= Math.max(...rates.map((tier) => tier.inputUsdPerMillionTokens)) * 1e6 - 1, model);
    assert.equal(pin.maxOutputTokens, MARKETING_LLM_MAX_OUTPUT_TOKENS);
    assert.equal(pin.maxWebSearchCalls, MARKETING_LLM_WEB_SEARCH_CALLS);
    assert.ok(pin.webSearchMicroUsdPerCall >= MARKETING_OPENAI_WEB_SEARCH_MICRO_USD_PER_CALL);
    assert.deepEqual(pin.tiers, ["default"]);
  }
});

test("only a pin the ledger accepts is selectable, and every other option says why", () => {
  for (const entry of options.filter((candidate) => candidate.pin)) {
    const problems = marketingLlmPinProblems(entry.pin);
    assert.equal(entry.unavailable === null, problems.length === 0, entry.model);
    if (entry.unavailable === null) assert.equal(marketingLlmPinAllows(entry.pin, MARKETING_LLM_WEB_SEARCH_PROFILE), true);
  }
  // The 1.05M-window catalog models fit the raised row limits.
  assert.equal(option("gpt-5.4-mini")?.unavailable, null);
  assert.equal(option("gpt-6-luna")?.unavailable, null);
});

test("a model the catalog cannot price or size is listed but not selectable", () => {
  const base = AVAILABLE_MODELS.find((model) => model.apiModel === "gpt-5.4-mini");
  const listed = marketingLlmModelOptionsFrom([
    { ...base, id: "unpriced-test-model", apiModel: "unpriced-test-model" },
    { ...base, id: "unsized-test-model", apiModel: "unsized-test-model", contextWindowTokens: undefined },
    { ...base, id: "disabled-test-model", apiModel: "disabled-test-model", enabled: false },
    // One registry rate leaves the other to the fallback: not a verified price.
    { ...base, id: "half-priced-test-model", apiModel: "half-priced-test-model", inputUsdPerMillionTokens: 0.1 },
    { ...base, id: "cache-only-test-model", apiModel: "cache-only-test-model", cachedInputPriceMultiplier: 0.1 },
    // A catalog row re-pointed at another API model keeps no profile price.
    { ...base, apiModel: "gpt-5.6-sol" },
  ]);
  assert.deepEqual(
    listed.map((entry) => [entry.model, entry.unavailable]),
    [
      ["unpriced-test-model", "price_unverified"],
      ["unsized-test-model", "context_window_unknown"],
      ["half-priced-test-model", "price_unverified"],
      ["cache-only-test-model", "price_unverified"],
      ["gpt-5.6-sol", "price_unverified"],
    ],
  );
});

test("a registry override below the profile cannot lower a pin's rate under the profile's worst tier", () => {
  const base = AVAILABLE_MODELS.find((model) => model.apiModel === "gpt-6-luna");
  const [plain] = marketingLlmModelOptionsFrom([base]);
  const [lowered] = marketingLlmModelOptionsFrom([{ ...base, inputUsdPerMillionTokens: 0.01, outputUsdPerMillionTokens: 0.01 }]);
  assert.equal(lowered.unavailable, null);
  assert.equal(lowered.pin.worstInputMicroUsdPerMillion, plain.pin.worstInputMicroUsdPerMillion);
  assert.equal(lowered.pin.worstOutputMicroUsdPerMillion, plain.pin.worstOutputMicroUsdPerMillion);
  // A higher override is honoured.
  const [raised] = marketingLlmModelOptionsFrom([{ ...base, inputUsdPerMillionTokens: 1_000, outputUsdPerMillionTokens: 1_000 }]);
  assert.equal(raised.pin.worstInputMicroUsdPerMillion, 1_000_000_000);
});

test("a registry window cannot narrow the code catalog's, and two rows for one API model choose neither", () => {
  const luna = AVAILABLE_MODELS.find((model) => model.apiModel === "gpt-6-luna");
  const [narrowed] = marketingLlmModelOptionsFrom([{ ...luna, contextWindowTokens: 8_000 }]);
  assert.equal(narrowed.pin.contextWindowTokens, luna.contextWindowTokens);
  const twice = marketingLlmModelOptionsFrom([
    luna,
    { ...luna, id: "cheap-luna-row", inputUsdPerMillionTokens: 0.01, outputUsdPerMillionTokens: 0.01 },
  ]);
  assert.deepEqual(
    twice.map((entry) => [entry.model, entry.unavailable]),
    [["gpt-6-luna", "api_model_duplicated"]],
  );
});

test("an operator's registry price for both input and output is a verified price", () => {
  const base = AVAILABLE_MODELS.find((model) => model.apiModel === "gpt-5.4-mini");
  const [entry] = marketingLlmModelOptionsFrom([
    { ...base, id: "registry-priced-test-model", apiModel: "registry-priced-test-model", inputUsdPerMillionTokens: 0.5, outputUsdPerMillionTokens: 2 },
  ]);
  assert.equal(entry.unavailable, null);
  assert.equal(entry.pin.worstInputMicroUsdPerMillion, 500_000);
  assert.equal(entry.pin.worstOutputMicroUsdPerMillion, 2_000_000);
});

test("the reservation's search overshoot is the chat path's recorded one", () => {
  assert.equal(MARKETING_OPENAI_SEARCH_OVERSHOOT_ALLOWANCE, OPENAI_SEARCH_OVERSHOOT_ALLOWANCE);
  // A web-search reservation holds one search and one model pass more than
  // the request asks for.
  const { pin } = option("gpt-5.4-mini");
  const billable = MARKETING_LLM_WEB_SEARCH_CALLS + OPENAI_SEARCH_OVERSHOOT_ALLOWANCE;
  assert.equal(marketingLlmReservation(pin, MARKETING_LLM_WEB_SEARCH_PROFILE).reservedInputTokens, pin.contextWindowTokens * (billable + 1));
});
