import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  CACHE_WRITE_PRICING_IS_BILLED_WHERE_MEASURED,
  MODEL_LIST_ENDPOINT_IS_NOT_A_PRICE_SOURCE,
  MODEL_PRICING,
  RESPONSE_PROCESSING_TIER_IS_NOT_RECORDED,
  resolveModelPricing,
} from "@/lib/modelPricing";
import { calculateProviderUsageCost } from "@/lib/providerUsageCost";
import { PROCESSING_TIER_REQUEST_ALLOWLIST } from "../scripts/check-processing-tier-core.mjs";
import { getModel } from "@/lib/models";

// The published OpenAI Standard rates these two models are billed at, per
// million tokens. Written out here rather than derived from the registry so
// the test fails when the registry moves, which is the whole point of it.
const PUBLISHED = {
  "gpt-5-6-luna": {
    short: { input: 0.2, cachedInput: 0.02, cacheWrite: 0.25, output: 1.2 },
    long: { input: 0.4, cachedInput: 0.04, cacheWrite: 0.5, output: 1.8 },
    longContextThresholdTokens: 272_000,
  },
  "gpt-5-4-mini": {
    flat: { input: 0.75, cachedInput: 0.075, output: 4.5 },
  },
} as const;

// Rates are derived by multiplication (the long tier is the short tier x2 and
// x1.5, the cached rate is the input rate x0.1), so binary floating point puts
// 1.2 x 1.5 at 1.7999999999999998. Compare at sub-cent precision: the question
// is whether the published rate is applied, not which double represents it.
const usd = (value: number) => Number(value.toFixed(6));

const profileFor = (modelId: string) => {
  const profile = MODEL_PRICING.find((entry) => entry.modelId === modelId);
  assert.ok(profile, `${modelId} must have an explicit profile, not a fallback`);
  return profile;
};

// A model resolved with its price columns cleared -- the state the registry
// contract says every seeded row is in.
const inherited = (modelId: string) => {
  const model = getModel(modelId);
  assert.ok(model, modelId);
  return {
    ...model,
    inputUsdPerMillionTokens: undefined,
    outputUsdPerMillionTokens: undefined,
    cachedInputPriceMultiplier: undefined,
  };
};

test("Luna prices its short and long context tiers separately", () => {
  const expected = PUBLISHED["gpt-5-6-luna"];
  const model = inherited("gpt-5-6-luna");

  const short = resolveModelPricing(model, { estimatedPromptTokens: 10_000 });
  assert.equal(usd(short.inputUsdPerMillionTokens), expected.short.input);
  assert.equal(usd(short.outputUsdPerMillionTokens), expected.short.output);
  assert.equal(
    usd(short.inputUsdPerMillionTokens * short.cachedInputPriceMultiplier),
    expected.short.cachedInput
  );
  assert.equal(short.costSource, "registry");
  assert.equal(short.longContextThresholdTokens, null);

  const long = resolveModelPricing(model, {
    estimatedPromptTokens: expected.longContextThresholdTokens + 1,
  });
  assert.equal(usd(long.inputUsdPerMillionTokens), expected.long.input);
  assert.equal(usd(long.outputUsdPerMillionTokens), expected.long.output);
  assert.equal(
    usd(long.inputUsdPerMillionTokens * long.cachedInputPriceMultiplier),
    expected.long.cachedInput
  );
  assert.equal(long.costSource, "registry_long_context");
  assert.equal(
    long.longContextThresholdTokens,
    expected.longContextThresholdTokens
  );
});

test("Luna's cache-write rates are recorded on both tiers and cost nothing without a write count", () => {
  const expected = PUBLISHED["gpt-5-6-luna"];
  const [short, long] = profileFor("gpt-5-6-luna").tiers;

  assert.equal(usd(short.cacheWriteUsdPerMillionTokens!), expected.short.cacheWrite);
  assert.equal(usd(long.cacheWriteUsdPerMillionTokens!), expected.long.cacheWrite);

  // The rate is now resolved rather than withheld -- Anthropic prompt caching
  // gave this application its first cache-write token count, so the resolver
  // carries the rate for every model that publishes one.
  assert.equal(CACHE_WRITE_PRICING_IS_BILLED_WHERE_MEASURED, true);
  const resolved = resolveModelPricing(inherited("gpt-5-6-luna"));
  assert.equal(usd(resolved.cacheWriteUsdPerMillionTokens!), expected.short.cacheWrite);

  // Carrying the rate is not the same as charging for it. No OpenAI usage
  // adapter reports cache-*write* tokens, so Luna's write count is zero on
  // every turn and the cost is zero for want of a measurement -- not because
  // the rate is missing. That distinction is the whole point of billing on
  // both halves: if an adapter ever starts reporting the count, this stops
  // being zero without anybody having to remember to flip a flag.
  const priced = calculateProviderUsageCost({
    inputTokens: 10_000,
    outputTokens: 0,
    inputUsdPerMillionTokens: resolved.inputUsdPerMillionTokens,
    outputUsdPerMillionTokens: resolved.outputUsdPerMillionTokens,
    cacheWriteUsdPerMillionTokens: resolved.cacheWriteUsdPerMillionTokens,
  });
  assert.equal(priced.cacheWriteInputTokens, 0);
  assert.equal(priced.cacheWriteInputCostMicroUsd, 0);
  assert.equal(priced.unpricedCacheWriteTokens, 0);
});

test("GPT-5.4 mini is flat-priced, with no invented cache-write rate", () => {
  const expected = PUBLISHED["gpt-5-4-mini"].flat;
  const profile = profileFor("gpt-5-4-mini");

  assert.equal(profile.apiModelId, "gpt-5.4-mini");
  assert.equal(profile.tiers.length, 1, "5.4 mini publishes no context step");
  assert.equal(profile.tiers[0].maxPromptTokens, null);

  const pricing = resolveModelPricing(inherited("gpt-5-4-mini"), {
    estimatedPromptTokens: 350_000,
  });
  assert.equal(usd(pricing.inputUsdPerMillionTokens), expected.input);
  assert.equal(usd(pricing.outputUsdPerMillionTokens), expected.output);
  assert.equal(
    usd(pricing.inputUsdPerMillionTokens * pricing.cachedInputPriceMultiplier),
    expected.cachedInput
  );
  assert.equal(pricing.costSource, "registry");
  assert.equal(
    profile.tiers[0].cacheWriteUsdPerMillionTokens,
    undefined,
    "no cache-write price was verified for 5.4 mini, and an unverified one must not be recorded"
  );
});

test("every profile is priced for a direct call at the standard tier", () => {
  for (const profile of MODEL_PRICING) {
    assert.equal(profile.routing, "direct_provider_api", profile.modelId);
    assert.equal(profile.processingTier, "standard", profile.modelId);
  }
  // The claim above only holds while no request selects a tier -- an omitted
  // OpenAI `service_tier` is served as `auto`, not necessarily as Standard.
  // npm run check:model-pricing surfaces every mention; this pins what the
  // exceptions are allowed to be.
  for (const entry of PROCESSING_TIER_REQUEST_ALLOWLIST) {
    assert.equal(
      entry.sendsATier,
      false,
      `${entry.file}: no file may put a tier on an outbound request while every profile records Standard pricing`
    );
    assert.ok(
      entry.reason.trim().length > 30,
      `${entry.file}: an exception needs a reason a reviewer can check, not a path in a list`
    );
  }

  // Reading the tier back is the gap, not a violation of it: no chat-path
  // snapshot records the tier a request was actually served at.
  assert.equal(RESPONSE_PROCESSING_TIER_IS_NOT_RECORDED, true);
});

test("the processing-tier guard sees files that are not committed yet", () => {
  // It did not, and that is why CI caught what a local run had passed:
  // `git grep` reads tracked files only, so a brand-new script was invisible
  // until it was committed. A guard whose answer depends on `git add` is not
  // a guard.
  const source = readFileSync(
    join(process.cwd(), "scripts/check-model-pricing.mjs"),
    "utf8"
  );
  const args = source.slice(source.indexOf("const tierGrep"), source.indexOf("const allowedTierFiles"));
  assert.match(args, /"--untracked"/);
});

test("the model-list endpoint is documented as not being a price source", () => {
  assert.equal(MODEL_LIST_ENDPOINT_IS_NOT_A_PRICE_SOURCE, true);
  for (const profile of MODEL_PRICING) {
    assert.ok(
      !/v1[_/]?models|models_list|list_models/i.test(profile.priceSource),
      `${profile.modelId}: priceSource must name a published pricing page, not a model-list response`
    );
  }
});
