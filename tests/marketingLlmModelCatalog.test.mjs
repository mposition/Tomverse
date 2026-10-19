import assert from "node:assert/strict";
import test from "node:test";

import {
  MARKETING_LLM_MAX_OUTPUT_TOKENS,
  MARKETING_LLM_WEB_SEARCH_CALLS,
  MARKETING_LLM_WEB_SEARCH_PROFILE,
  MARKETING_OPENAI_WEB_SEARCH_MICRO_USD_PER_CALL,
  marketingLlmPinAllows,
  marketingLlmPinProblems,
} from "@/lib/marketingLlmBudgetCore";
import { marketingLlmCatalogPins, marketingLlmModelOptions } from "@/lib/marketingLlmModelCatalog";
import { MODEL_PRICING } from "@/lib/modelPricing";
import { AVAILABLE_MODELS } from "@/lib/models";

const options = marketingLlmModelOptions();

test("the options are the enabled OpenAI models the chat catalog prices, once each", () => {
  assert.ok(options.length > 0);
  const ids = options.map((option) => option.model);
  assert.equal(new Set(ids).size, ids.length);
  for (const option of options) {
    const model = AVAILABLE_MODELS.find((entry) => entry.apiModel === option.model && entry.provider === "openai");
    assert.ok(model, option.model);
    assert.ok(MODEL_PRICING.some((profile) => profile.apiModelId === option.model), option.model);
  }
});

test("a pin is the catalog price at its worst, with the generator's own caps and OpenAI's search price", () => {
  for (const { pin, model } of options) {
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
  for (const option of options) {
    const problems = marketingLlmPinProblems(option.pin);
    assert.equal(option.unavailable === null, problems.length === 0, option.model);
    if (option.unavailable === null) assert.equal(marketingLlmPinAllows(option.pin, MARKETING_LLM_WEB_SEARCH_PROFILE), true);
  }
  assert.deepEqual(
    marketingLlmCatalogPins().map((pin) => pin.model),
    options.filter((option) => option.unavailable === null).map((option) => option.model),
  );
  // As built: 5.4 mini fits the ledger's row limits; a 1.05M window does not.
  assert.equal(options.find((option) => option.model === "gpt-5.4-mini")?.unavailable, null);
  assert.match(options.find((option) => option.model === "gpt-6-luna")?.unavailable ?? "", /context_window_over_row_limit/);
});
