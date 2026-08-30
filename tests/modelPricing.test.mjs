import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AVAILABLE_MODELS, getModelBillingProfile } from "../lib/models.ts";
import {
  FALLBACK_PRICING,
  MODEL_PRICING,
  findUnpricedModels,
  getModelPricingProfile,
  getNativeSearchCostMicroUsdPerQuery,
  PENDING_VERIFIED_PRICE_MODEL_IDS,
  PROMPT_CACHE_READ_PRICE_MULTIPLIER,
  PROMPT_CACHE_WRITE_5M_PRICE_MULTIPLIER,
  resolveModelPricing,
} from "../lib/modelPricing.ts";
import { calculateProviderUsageCost } from "../lib/providerUsageCost.ts";

const model = (modelId) => {
  const found = AVAILABLE_MODELS.find((candidate) => candidate.id === modelId);
  assert.ok(found, `model ${modelId} is missing from the registry`);
  return found;
};

// Token counts recovered from the production incident. All three models were
// billed at the generic premium rate of US$15 input / US$60 output per million
// tokens, which is what the reported internal costs decompose to for a shared
// 3,469-token prompt:
//   Claude Opus 4.8   15*3469 + 60*2500 = 202,035 micro-USD (US$0.202035)
//   Gemini 3.1 Pro    15*3469 + 60*7710 = 514,635 micro-USD (US$0.514635)
//   GPT-5.5 Thinking  15*3469 + 60*6713 = 454,815 micro-USD (US$0.454815)
const INCIDENT_PROMPT_TOKENS = 3_469;
const INCIDENT_OUTPUT_TOKENS = {
  "claude-opus-4-8": 2_500,
  "gemini-3-1-pro": 7_710,
  "gpt-5-5-thinking": 6_713,
};

const costFor = (modelId, { inputTokens, outputTokens }) => {
  const pricing = resolveModelPricing(model(modelId), {
    estimatedPromptTokens: inputTokens,
  });
  return calculateProviderUsageCost({
    inputTokens,
    outputTokens,
    inputUsdPerMillionTokens: pricing.inputUsdPerMillionTokens,
    outputUsdPerMillionTokens: pricing.outputUsdPerMillionTokens,
    cachedInputPriceMultiplier: pricing.cachedInputPriceMultiplier,
  }).totalCostMicroUsd;
};

test("the four incident models carry explicit standard-API pricing", () => {
  const expected = {
    "gpt-5-5": { input: 5, output: 30 },
    "gpt-5-5-thinking": { input: 5, output: 30 },
    "gemini-3-1-pro": { input: 2, output: 12 },
    "claude-opus-4-8": { input: 5, output: 25 },
  };
  for (const [modelId, rates] of Object.entries(expected)) {
    const pricing = resolveModelPricing(model(modelId), {
      estimatedPromptTokens: 4_000,
    });
    assert.equal(pricing.inputUsdPerMillionTokens, rates.input, modelId);
    assert.equal(pricing.outputUsdPerMillionTokens, rates.output, modelId);
    assert.equal(pricing.isFallbackPricing, false, modelId);
    assert.equal(pricing.costSource, "registry", modelId);
    // Verified against lib/activeAiModel.ts: first-party endpoints, no relay,
    // no priority/flex tier override in the request.
    assert.equal(pricing.routing, "direct_provider_api", modelId);
    assert.equal(pricing.processingTier, "standard", modelId);
    assert.ok(pricing.pricingVersion.length > 0, modelId);
    assert.ok(pricing.priceSource.length > 0, modelId);
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(pricing.effectiveDate), modelId);
  }
});

test("the generic premium fallback no longer applies to the incident models", () => {
  assert.equal(FALLBACK_PRICING.premium.tiers[0].inputUsdPerMillionTokens, 15);
  assert.equal(FALLBACK_PRICING.premium.tiers[0].outputUsdPerMillionTokens, 60);
  for (const modelId of [
    "gpt-5-5",
    "gpt-5-5-thinking",
    "gemini-3-1-pro",
    "claude-opus-4-8",
  ]) {
    const profile = getModelBillingProfile(model(modelId));
    assert.notEqual(profile.inputUsdPerMillionTokens, 15, modelId);
    assert.notEqual(profile.outputUsdPerMillionTokens, 60, modelId);
  }
});

test("the reproduction token counts price at the official rates", () => {
  const opus = costFor("claude-opus-4-8", {
    inputTokens: INCIDENT_PROMPT_TOKENS,
    outputTokens: INCIDENT_OUTPUT_TOKENS["claude-opus-4-8"],
  });
  const gemini = costFor("gemini-3-1-pro", {
    inputTokens: INCIDENT_PROMPT_TOKENS,
    outputTokens: INCIDENT_OUTPUT_TOKENS["gemini-3-1-pro"],
  });
  const gpt = costFor("gpt-5-5-thinking", {
    inputTokens: INCIDENT_PROMPT_TOKENS,
    outputTokens: INCIDENT_OUTPUT_TOKENS["gpt-5-5-thinking"],
  });

  assert.equal(opus, 3_469 * 5 + 2_500 * 25);
  assert.equal(gemini, 3_469 * 2 + 7_710 * 12);
  assert.equal(gpt, 3_469 * 5 + 6_713 * 30);

  // The same three responses cost US$1.171485 internally under generic pricing.
  const previouslyReported = 202_035 + 514_635 + 454_815;
  assert.equal(previouslyReported, 1_171_485);
  assert.ok(opus + gemini + gpt < previouslyReported / 2);
});

test("Gemini 3.1 Pro switches price tier at the 200K prompt boundary", () => {
  const below = resolveModelPricing(model("gemini-3-1-pro"), {
    estimatedPromptTokens: 200_000,
  });
  assert.equal(below.inputUsdPerMillionTokens, 2);
  assert.equal(below.outputUsdPerMillionTokens, 12);
  assert.equal(below.costSource, "registry");
  assert.equal(below.longContextThresholdTokens, null);

  const above = resolveModelPricing(model("gemini-3-1-pro"), {
    estimatedPromptTokens: 200_001,
  });
  assert.equal(above.inputUsdPerMillionTokens, 4);
  assert.equal(above.outputUsdPerMillionTokens, 18);
  assert.equal(above.costSource, "registry_long_context");
  assert.equal(above.longContextThresholdTokens, 200_000);
});

// The migration writes numbers into the database; this file is where those
// numbers are decided. Nothing else connects them, so a later price change
// here would leave the deployed rows behind -- which is exactly how the four
// incident models ended up frozen at the fallback in the first place. This
// reads the SQL and fails if the two disagree.
test("the price-correction migration writes what this registry says", () => {
  const sql = readFileSync(
    join(
      import.meta.dirname,
      "..",
      "prisma",
      "migrations",
      "20260802010000_reconcile_incident_model_prices",
      "migration.sql"
    ),
    "utf8"
  ).replace(/--[^\n]*/g, "");

  const statements = sql.split(";").filter((s) => /UPDATE/i.test(s));
  assert.equal(statements.length, 3, "expected one statement per applied price");

  const applied = new Map();
  for (const statement of statements) {
    const price = /"inputUsdPerMillionTokens"\s*=\s*([\d.]+)\s*,\s*"outputUsdPerMillionTokens"\s*=\s*([\d.]+)/.exec(
      statement
    );
    assert.ok(price, `could not read the applied price from: ${statement.trim().slice(0, 60)}`);
    for (const [, id] of statement.matchAll(/'([a-z0-9.\-]+)'/g)) {
      if (id === "gpt-5-5" || !applied.has(id)) applied.set(id, [Number(price[1]), Number(price[2])]);
    }
  }

  assert.deepEqual(
    [...applied.keys()].sort(),
    ["claude-opus-4-8", "gemini-3-1-pro", "gpt-5-5", "gpt-5-5-thinking"],
    "the migration must target exactly the four incident models"
  );

  for (const [modelId, [input, output]] of applied) {
    const profile = getModelPricingProfile(modelId);
    assert.ok(profile, `${modelId} must have an explicit profile`);
    assert.equal(profile.tiers[0].inputUsdPerMillionTokens, input, modelId);
    assert.equal(profile.tiers[0].outputUsdPerMillionTokens, output, modelId);
  }

  // Guarded on the exact fallback pair, so an administrator's own price and an
  // already-corrected environment are both left alone.
  const premium = FALLBACK_PRICING.premium.tiers[0];
  for (const statement of statements) {
    assert.match(
      statement,
      new RegExp(`"inputUsdPerMillionTokens"\\s*=\\s*${premium.inputUsdPerMillionTokens}\\b`),
      "each statement must be guarded on the fallback input price"
    );
    assert.match(
      statement,
      new RegExp(`"outputUsdPerMillionTokens"\\s*=\\s*${premium.outputUsdPerMillionTokens}\\b`),
      "each statement must be guarded on the fallback output price"
    );
    assert.doesNotMatch(
      statement,
      /"enabled"|"publiclyListed"|"status"|"creditWeight"|"reservationOutputTokens"|"maxOutputTokens"/,
      "this migration corrects prices only"
    );
  }
});

// A stored registry price is a flat number, so it cannot express a tier: once
// gemini-3-1-pro's row holds 2/12 (migration 20260802010000), the 4/18
// long-context tier above 200K prompt tokens is unreachable through that row
// no matter what this file says, because resolveModelPricing reads
// `model.inputUsdPerMillionTokens ?? ...` first.
//
// That is safe only while a request cannot get past the boundary. The user
// ceiling is CHAT_USER_MAX_INPUT_TOKENS, defaulting to 128,000 in
// lib/chatSecurity.ts. Raising it to 200,000 or beyond without first clearing
// that stored price would silently bill long-context Gemini requests at the
// short-context rate -- understating cost, which is the direction this
// codebase never accepts.
test("raising the input ceiling past a long-context boundary is not silent", () => {
  const source = readFileSync(
    join(import.meta.dirname, "..", "lib", "chatSecurity.ts"),
    "utf8"
  );
  const ceiling = /CHAT_USER_MAX_INPUT_TOKENS,\s*([\d_]+)\)/.exec(source);
  assert.ok(ceiling, "could not read the default user input ceiling");
  const maxInputTokens = Number(ceiling[1].replace(/_/g, ""));

  const tiered = getModelPricingProfile("gemini-3-1-pro");
  assert.ok(tiered, "gemini-3-1-pro must keep a tiered profile");
  const boundary = tiered.tiers[0].maxPromptTokens;
  assert.equal(boundary, 200_000);

  assert.ok(
    maxInputTokens <= boundary,
    `CHAT_USER_MAX_INPUT_TOKENS is ${maxInputTokens}, past gemini-3-1-pro's ${boundary}-token tier boundary. A flat price stored on the registry row cannot express the ${tiered.tiers[1].inputUsdPerMillionTokens}/${tiered.tiers[1].outputUsdPerMillionTokens} tier, so clear that row's inputUsdPerMillionTokens/outputUsdPerMillionTokens before raising this ceiling.`
  );
});

test("new catalogue models use their exact provider prices and output caps", () => {
  const expected = {
    "gpt-5-6-sol": [5, 30, 128_000],
    "gpt-5-6-terra": [2, 12, 128_000],
    "gpt-5-6-luna": [0.2, 1.2, 128_000],
    "gemini-3-6-flash": [1.5, 7.5, 65_536],
    "gemini-3-5-flash": [1.5, 9, 65_536],
    "gemini-2-5-flash": [0.3, 2.5, 65_536],
    "grok-4-3": [1.25, 2.5, 16_384],
    "grok-4-5": [2, 6, 16_384],
    "mistral-medium-3-1": [1.5, 7.5, 16_384],
    "claude-fable-5": [10, 50, 128_000],
    // 131,072 is the documented request default; the 1,048,576 ceiling is a
    // capability and is carried separately as providerMaxOutputTokens.
    "kimi-k3": [3, 15, 131_072],
    "minimax-m3": [0.3, 1.2, 524_288],
  };

  for (const [modelId, [input, output, maxOutputTokens]] of Object.entries(expected)) {
    const pricing = resolveModelPricing(model(modelId), {
      estimatedPromptTokens: 10_000,
    });
    assert.equal(pricing.inputUsdPerMillionTokens, input, modelId);
    assert.equal(pricing.outputUsdPerMillionTokens, output, modelId);
    assert.equal(pricing.maxOutputTokens, maxOutputTokens, modelId);
    assert.equal(pricing.isFallbackPricing, false, modelId);
    assert.equal(pricing.routing, "direct_provider_api", modelId);
  }

  const mistralMedium = resolveModelPricing(model("mistral-medium-3-1"));
  assert.equal(mistralMedium.cachedInputPriceMultiplier, 1);
  assert.equal(mistralMedium.cachedInputPricingVerified, false);

  const fable = resolveModelPricing(model("claude-fable-5"));
  assert.equal(fable.cachedInputPriceMultiplier, 0.1);
  assert.equal(fable.cachedInputPricingVerified, true);

  const kimi = resolveModelPricing(model("kimi-k3"));
  assert.equal(kimi.cachedInputPriceMultiplier, 0.1);
  assert.equal(kimi.cachedInputPricingVerified, true);
});

test("MiniMax M3 switches price tier above a 512K prompt", () => {
  const short = resolveModelPricing(model("minimax-m3"), {
    estimatedPromptTokens: 512_000,
  });
  const long = resolveModelPricing(model("minimax-m3"), {
    estimatedPromptTokens: 512_001,
  });
  assert.deepEqual(
    [short.inputUsdPerMillionTokens, short.outputUsdPerMillionTokens],
    [0.3, 1.2]
  );
  assert.deepEqual(
    [long.inputUsdPerMillionTokens, long.outputUsdPerMillionTokens],
    [0.6, 2.4]
  );
  assert.equal(long.costSource, "registry_long_context");
  assert.equal(long.longContextThresholdTokens, 512_000);
});

test("GPT-5.6 and Grok long-context tiers apply at their documented boundaries", () => {
  const solShort = resolveModelPricing(model("gpt-5-6-sol"), {
    estimatedPromptTokens: 272_000,
  });
  const solLong = resolveModelPricing(model("gpt-5-6-sol"), {
    estimatedPromptTokens: 272_001,
  });
  assert.deepEqual(
    [solShort.inputUsdPerMillionTokens, solShort.outputUsdPerMillionTokens],
    [5, 30]
  );
  assert.deepEqual(
    [solLong.inputUsdPerMillionTokens, solLong.outputUsdPerMillionTokens],
    [10, 45]
  );

  for (const [modelId, shortRates, longRates] of [
    ["grok-4-3", [1.25, 2.5], [2.5, 5]],
    ["grok-4-5", [2, 6], [4, 12]],
  ]) {
    const short = resolveModelPricing(model(modelId), {
      estimatedPromptTokens: 199_999,
    });
    const long = resolveModelPricing(model(modelId), {
      estimatedPromptTokens: 200_000,
    });
    assert.deepEqual(
      [short.inputUsdPerMillionTokens, short.outputUsdPerMillionTokens],
      shortRates,
      modelId
    );
    assert.deepEqual(
      [long.inputUsdPerMillionTokens, long.outputUsdPerMillionTokens],
      longRates,
      modelId
    );
  }
});

test("flat-priced models are unaffected by prompt size", () => {
  for (const modelId of ["gpt-5-5", "gpt-5-5-thinking", "claude-opus-4-8"]) {
    const small = resolveModelPricing(model(modelId), {
      estimatedPromptTokens: 500,
    });
    const large = resolveModelPricing(model(modelId), {
      estimatedPromptTokens: 500_000,
    });
    assert.deepEqual(
      [small.inputUsdPerMillionTokens, small.outputUsdPerMillionTokens],
      [large.inputUsdPerMillionTokens, large.outputUsdPerMillionTokens],
      modelId
    );
    assert.equal(large.longContextThresholdTokens, null, modelId);
  }
});

test("reasoning tokens bill at the output rate and get their own reservation headroom", () => {
  const thinking = resolveModelPricing(model("gpt-5-5-thinking"));
  const nonThinking = resolveModelPricing(model("gpt-5-5"));

  // Same upstream model, same price -- only the reserved output differs.
  assert.equal(thinking.apiModelId, nonThinking.apiModelId);
  assert.equal(
    thinking.outputUsdPerMillionTokens,
    nonThinking.outputUsdPerMillionTokens
  );
  assert.equal(thinking.reasoningTokenBilling, "billed_as_output");
  assert.ok(
    thinking.reservationOutputTokens > nonThinking.reservationOutputTokens
  );
  assert.ok(thinking.reservationOutputTokens <= thinking.maxOutputTokens);

  // A settled turn whose output is mostly reasoning costs the same as one of
  // equal total length that is all text -- reasoning is inside `outputTokens`.
  const allText = costFor("gpt-5-5-thinking", {
    inputTokens: 1_000,
    outputTokens: 4_000,
  });
  const mostlyReasoning = costFor("gpt-5-5-thinking", {
    inputTokens: 1_000,
    outputTokens: 4_000,
  });
  assert.equal(allText, mostlyReasoning);
});

test("native web search prices come from the registry, per provider", () => {
  assert.equal(getNativeSearchCostMicroUsdPerQuery("openai"), 10_000);
  assert.equal(getNativeSearchCostMicroUsdPerQuery("anthropic"), 10_000);
  assert.equal(getNativeSearchCostMicroUsdPerQuery("google"), 14_000);
  // Perplexity reports its own response cost and must never also be charged a
  // flat per-query estimate.
  assert.equal(getNativeSearchCostMicroUsdPerQuery("perplexity"), undefined);

  for (const modelId of ["gpt-5-5", "claude-opus-4-8", "gemini-3-1-pro"]) {
    const pricing = resolveModelPricing(model(modelId));
    assert.ok(
      (pricing.nativeSearchCostMicroUsdPerQuery ?? 0) > 0,
      `${modelId} should declare a native search price`
    );
  }
});

test("an unknown model falls back conservatively and is reported, not hidden", () => {
  const unknown = {
    id: "totally-new-premium-model",
    usageClass: "premium",
    provider: "openai",
    apiModel: "totally-new-premium-model",
  };
  const pricing = resolveModelPricing(unknown, { estimatedPromptTokens: 1_000 });
  assert.equal(pricing.isFallbackPricing, true);
  assert.equal(pricing.costSource, "conservative_fallback");
  assert.equal(pricing.inputUsdPerMillionTokens, 15);
  assert.equal(pricing.outputUsdPerMillionTokens, 60);

  const reported = findUnpricedModels([{ ...unknown, enabled: true }]);
  assert.equal(reported.length, 1);
  assert.equal(reported[0].severity, "error");
});

// Half a price is not a price. `resolveModelPricing` falls back per side, so a
// row carrying only an input price bills its output on the conservative class
// fallback -- and output is the expensive half. The check used to require both
// ends to be missing before it said anything, so this row read as priced.
test("a premium model priced on only one side is still unpriced", () => {
  const half = {
    id: "half-priced-premium-model",
    usageClass: "premium",
    provider: "openai",
    apiModel: "half-priced-premium-model",
    enabled: true,
  };

  const inputOnly = { ...half, inputUsdPerMillionTokens: 1.25 };
  assert.equal(
    resolveModelPricing(inputOnly).outputUsdPerMillionTokens,
    60,
    "the unspecified side should come from the fallback, which is the problem"
  );
  assert.equal(findUnpricedModels([inputOnly])[0]?.severity, "error");

  const outputOnly = { ...half, outputUsdPerMillionTokens: 10 };
  assert.equal(findUnpricedModels([outputOnly])[0]?.severity, "error");

  // Both ends together is what "priced" means.
  assert.deepEqual(
    findUnpricedModels([
      { ...half, inputUsdPerMillionTokens: 1.25, outputUsdPerMillionTokens: 10 },
    ]),
    []
  );
});

test("no enabled premium model is silently unpriced", () => {
  const unpriced = findUnpricedModels(AVAILABLE_MODELS);
  assert.deepEqual(
    unpriced.filter((entry) => entry.severity === "error"),
    []
  );
  // Everything acknowledged as pending must actually still be unpriced, so the
  // list cannot quietly grow stale and start covering a real regression.
  for (const modelId of PENDING_VERIFIED_PRICE_MODEL_IDS) {
    assert.ok(
      unpriced.some((entry) => entry.modelId === modelId),
      `${modelId} is priced now and should leave PENDING_VERIFIED_PRICE_MODEL_IDS`
    );
  }
});

test("current profiles expose verified limits without mutating stored snapshots", () => {
  // Stored reservations/settlements retain their pricingVersion and costSource;
  // these assertions cover only the profile used for future requests.
  assert.deepEqual(getModelBillingProfile(model("deepseek-v4-flash")), {
    maxOutputTokens: 384_000,
    reservationOutputTokens: 4_096,
    inputUsdPerMillionTokens: 0.14,
    outputUsdPerMillionTokens: 0.28,
    cachedInputPriceMultiplier: 0.02,
  });
  assert.deepEqual(getModelBillingProfile(model("deepseek-v4-pro")), {
    maxOutputTokens: 384_000,
    reservationOutputTokens: 8_192,
    inputUsdPerMillionTokens: 0.435,
    outputUsdPerMillionTokens: 0.87,
    cachedInputPriceMultiplier: 1 / 120,
  });
  assert.deepEqual(getModelBillingProfile(model("llama-4-scout")), {
    maxOutputTokens: 8_192,
    reservationOutputTokens: 2_048,
    inputUsdPerMillionTokens: 0.11,
    outputUsdPerMillionTokens: 0.34,
    cachedInputPriceMultiplier: 1,
  });
});

test("an admin registry price override wins over the registry and is labelled", () => {
  const overridden = {
    ...model("claude-opus-4-8"),
    inputUsdPerMillionTokens: 7.5,
    outputUsdPerMillionTokens: 40,
  };
  const pricing = resolveModelPricing(overridden);
  assert.equal(pricing.inputUsdPerMillionTokens, 7.5);
  assert.equal(pricing.outputUsdPerMillionTokens, 40);
  assert.equal(pricing.costSource, "model_registry_override");
});

test("every explicit profile has an unbounded final tier", () => {
  for (const modelId of [
    "gpt-5-5",
    "gpt-5-5-thinking",
    "gemini-3-1-pro",
    "claude-opus-4-8",
  ]) {
    const profile = getModelPricingProfile(modelId);
    assert.ok(profile);
    assert.equal(profile.tiers[profile.tiers.length - 1].maxPromptTokens, null);
  }
});

test("GLM-5.2's cached-input rate resolves to the published US$0.26, not a rounded multiplier", () => {
  // The profile stores a multiplier, but Z.AI publishes the cache-read rate as
  // an absolute US$0.26/1M. Writing a rounded 0.19 would charge US$0.266, and
  // the stored multiplier is what later re-prices a snapshot -- so the
  // reconstructed rate is the thing worth pinning, not the multiplier.
  const pricing = resolveModelPricing(model("glm-5.2"));
  assert.equal(pricing.costSource, "registry");
  assert.equal(pricing.inputUsdPerMillionTokens, 1.4);
  assert.equal(pricing.outputUsdPerMillionTokens, 4.4);
  const cachedUsdPerMillion =
    pricing.inputUsdPerMillionTokens * pricing.cachedInputPriceMultiplier;
  assert.ok(
    Math.abs(cachedUsdPerMillion - 0.26) < 1e-9,
    `cached input resolved to ${cachedUsdPerMillion}, expected 0.26`
  );
  assert.equal(pricing.cachedInputPricingVerified, true);
});

// --------------------------------------------------------------------------
// Claude Sonnet 5's price, and the 2026-09-01 boundary that turned out not to
// be one.
//
// This block replaces a date-triggered failure that was set to fire on
// 2026-09-01 demanding the rates move to US$3 / US$15. That demand was correct
// when it was written -- the launch announcement put the US$2 / US$10 rate on
// an end date of 2026-08-31 -- and it stopped being correct on 2026-08-11,
// when Anthropic cancelled the increase. Their pricing page's
// `claude-sonnet-5-introductory-pricing` note now reads: "is now the standard
// price. The previously scheduled increase to $3/$15 per million input/output
// tokens on September 1, 2026 will not occur."
//
// So the tests below pin the *opposite* of what the old one did: the rate does
// not move across that boundary. Moving them to US$3 / US$15 would overstate
// every Sonnet 5 request by 50%, and overstating is not the safe direction --
// provider budgets and the operational cost guardrails are spent against these
// numbers, so an inflated rate refuses requests that had the money for them.
//
// The date-triggered *mechanism* was not the mistake and is not being removed:
// nothing in this system notices a price change on its own. What replaced it is
// `priceSchedule` in lib/modelPricing.ts, which lets a dated revision be
// written down before it takes effect instead of guarded by a build that breaks
// on a calendar day.
// --------------------------------------------------------------------------

const SONNET_5_STANDARD = { input: 2, output: 10, cachedMultiplier: 0.1 };

test("Claude Sonnet 5 is priced at the standard US$2 / US$10 today", () => {
  const pricing = resolveModelPricing(model("claude-sonnet-5"));
  assert.equal(pricing.inputUsdPerMillionTokens, SONNET_5_STANDARD.input);
  assert.equal(pricing.outputUsdPerMillionTokens, SONNET_5_STANDARD.output);
  assert.equal(
    pricing.cachedInputPriceMultiplier,
    SONNET_5_STANDARD.cachedMultiplier
  );
  assert.equal(
    pricing.pricingVersion,
    "anthropic-claude-sonnet-5-standard-2026-08-11",
    "the price in force is the 2026-08-11 revision that made the introductory rate standard"
  );
  assert.equal(pricing.effectiveDate, "2026-08-11");
});

test("Claude Sonnet 5's rates are unchanged across the 2026-09-01 boundary", () => {
  // The two instants either side of the cancelled increase, to the
  // millisecond. Both must price identically: the increase will not occur, and
  // a registry that stepped up here would be billing a price Anthropic
  // withdrew.
  const lastMomentOfAugust = Date.parse("2026-08-31T23:59:59.999Z");
  const firstMomentOfSeptember = Date.parse("2026-09-01T00:00:00.000Z");

  const before = resolveModelPricing(model("claude-sonnet-5"), {
    at: lastMomentOfAugust,
  });
  const after = resolveModelPricing(model("claude-sonnet-5"), {
    at: firstMomentOfSeptember,
  });

  for (const [label, pricing] of [
    ["2026-08-31T23:59:59.999Z", before],
    ["2026-09-01T00:00:00.000Z", after],
  ]) {
    assert.equal(
      pricing.inputUsdPerMillionTokens,
      SONNET_5_STANDARD.input,
      `Sonnet 5 input rate at ${label}`
    );
    assert.equal(
      pricing.outputUsdPerMillionTokens,
      SONNET_5_STANDARD.output,
      `Sonnet 5 output rate at ${label}`
    );
  }
  assert.equal(
    before.pricingVersion,
    after.pricingVersion,
    "no price decision takes effect at the 2026-09-01 boundary, so the version must not change across it"
  );
});

test("a Sonnet 5 request dated before 2026-08-11 reproduces at the introductory version", () => {
  // Historical reproduction: re-pricing a stored reservation means asking the
  // registry what it said *then*. The rates are the same either side, and the
  // version is not -- which is the point. A settlement taken while the rate was
  // provisional and one taken after it was permanent are two different
  // decisions, and a ledger that files them under one version cannot tell them
  // apart afterwards.
  const beforeCancellation = resolveModelPricing(model("claude-sonnet-5"), {
    at: Date.parse("2026-08-10T23:59:59.999Z"),
  });
  const atCancellation = resolveModelPricing(model("claude-sonnet-5"), {
    at: Date.parse("2026-08-11T00:00:00.000Z"),
  });

  assert.equal(
    beforeCancellation.pricingVersion,
    "anthropic-claude-sonnet-5-intro-2026-08-04"
  );
  assert.equal(beforeCancellation.effectiveDate, "2026-08-04");
  assert.equal(
    atCancellation.pricingVersion,
    "anthropic-claude-sonnet-5-standard-2026-08-11"
  );

  // Same money, either side. The cancellation changed the term, not the number.
  assert.equal(
    beforeCancellation.inputUsdPerMillionTokens,
    atCancellation.inputUsdPerMillionTokens
  );
  assert.equal(
    beforeCancellation.outputUsdPerMillionTokens,
    atCancellation.outputUsdPerMillionTokens
  );
});

test("a scheduled revision takes effect on its own instant and not before", () => {
  // The mechanism itself, exercised on a synthetic profile so the assertion is
  // about the boundary rule rather than about any model's real rates.
  const profile = getModelPricingProfile("claude-sonnet-5");
  assert.ok(profile.priceSchedule?.length, "Sonnet 5 carries a price schedule");
  const revision = profile.priceSchedule[0];
  const instant = Date.parse(revision.effectiveFrom);

  const justBefore = resolveModelPricing(model("claude-sonnet-5"), {
    at: instant - 1,
  });
  const exactlyAt = resolveModelPricing(model("claude-sonnet-5"), {
    at: instant,
  });

  assert.equal(justBefore.pricingVersion, profile.pricingVersion);
  assert.equal(exactlyAt.pricingVersion, revision.pricingVersion);
  assert.equal(
    revision.effectiveDate,
    revision.effectiveFrom.slice(0, 10),
    "the snapshot date must be the instant's own UTC date"
  );
  assert.ok(
    revision.effectiveFrom.endsWith("Z"),
    "price boundaries are UTC instants, matching every other boundary in this system"
  );
});

test("a revision separates when it was read from when it takes effect", () => {
  // Two dates that are routinely different, and were collapsed into one until
  // the Sonnet 5 entry made the difference visible: Anthropic announced the
  // cancellation on 2026-08-10 and this registry bills it from
  // 2026-08-11T00:00:00Z.
  //
  // A provider publishes a *date*, not an instant, so a boundary has to be
  // chosen from the reading. The rule is the first instant of the following
  // UTC day, because that is the only choice that never prices a request by a
  // decision that had not been published when the request ran -- backdating to
  // the announcement day's own midnight would do exactly that for every
  // request earlier in that day.
  const revision = getModelPricingProfile("claude-sonnet-5").priceSchedule[0];
  assert.equal(revision.verifiedAt, "2026-08-10", "the announcement date");
  assert.equal(
    revision.effectiveFrom,
    "2026-08-11T00:00:00.000Z",
    "the billing boundary, one UTC day later"
  );
  assert.ok(
    Date.parse(`${revision.verifiedAt}T00:00:00.000Z`) <
      Date.parse(revision.effectiveFrom),
    "a boundary may never precede the reading that justifies it"
  );
  // The priceSource names the announcement rather than the boundary, so a
  // reader chasing the provenance lands on the date the page actually carries.
  assert.match(revision.priceSource, /2026_08_10/);

  // And here the choice costs nothing: the rates are identical either side, so
  // all the boundary decides is which pricingVersion a turn on the
  // announcement day is filed under.
  const announcementDay = resolveModelPricing(model("claude-sonnet-5"), {
    at: Date.parse("2026-08-10T12:00:00.000Z"),
  });
  const dayAfter = resolveModelPricing(model("claude-sonnet-5"), {
    at: Date.parse("2026-08-11T12:00:00.000Z"),
  });
  assert.equal(
    announcementDay.inputUsdPerMillionTokens,
    dayAfter.inputUsdPerMillionTokens
  );
  assert.notEqual(announcementDay.pricingVersion, dayAfter.pricingVersion);
});

test("every scheduled revision records the reading behind it", () => {
  // Provenance is not optional in practice, only in the type: a revision with
  // no `verifiedAt` is one nobody can trace to a published page. The type
  // allows it for a provider that publishes an explicit instant; no entry in
  // this registry has one yet.
  for (const profile of MODEL_PRICING) {
    for (const revision of profile.priceSchedule ?? []) {
      assert.ok(
        revision.verifiedAt,
        `${profile.modelId} revision ${revision.pricingVersion} records no verifiedAt`
      );
      assert.ok(
        Date.parse(`${revision.verifiedAt}T00:00:00.000Z`) <=
          Date.parse(revision.effectiveFrom),
        `${profile.modelId} revision ${revision.pricingVersion} takes effect before it was read`
      );
    }
  }
});

test("an explicit DB price override wins over a scheduled revision", () => {
  // The NULL-inherits contract (docs/policy/credit-and-cost-limits.md, the
  // 2026-08-02 section) is not weakened by the schedule: a registry row that
  // carries numbers is an administrator's decision, and a dated revision must
  // not override it. The flip side is that an override flattens the tiers, and
  // it flattens the schedule for the same reason -- a column cannot express
  // either.
  const base = model("claude-sonnet-5");
  const overridden = resolveModelPricing(
    {
      ...base,
      inputUsdPerMillionTokens: 7,
      outputUsdPerMillionTokens: 21,
      cachedInputPriceMultiplier: 0.5,
    },
    { at: Date.parse("2026-12-01T00:00:00.000Z") }
  );

  assert.equal(overridden.inputUsdPerMillionTokens, 7);
  assert.equal(overridden.outputUsdPerMillionTokens, 21);
  assert.equal(overridden.cachedInputPriceMultiplier, 0.5);
  assert.equal(overridden.costSource, "model_registry_override");

  // Inheriting rows are untouched by the override and still take the revision.
  const inherited = resolveModelPricing(base, {
    at: Date.parse("2026-12-01T00:00:00.000Z"),
  });
  assert.equal(inherited.costSource, "registry");
  assert.equal(inherited.inputUsdPerMillionTokens, SONNET_5_STANDARD.input);
});

test("every Anthropic cache-write rate is 1.25x its own input rate", () => {
  // The published 5-minute cache-write multiplier, checked against the rates
  // rather than used to compute them: each number here was read off Anthropic's
  // price table, and this is what catches a transcription slip.
  for (const modelId of [
    "claude-opus-4-8",
    "claude-fable-5",
    "claude-sonnet-5",
    "claude-haiku-4-5",
  ]) {
    const pricing = resolveModelPricing(model(modelId));
    assert.equal(
      typeof pricing.cacheWriteUsdPerMillionTokens,
      "number",
      `${modelId} must carry a verified cache-write rate now that it caches`
    );
    const expected =
      pricing.inputUsdPerMillionTokens * PROMPT_CACHE_WRITE_5M_PRICE_MULTIPLIER;
    assert.ok(
      Math.abs(pricing.cacheWriteUsdPerMillionTokens - expected) < 1e-9,
      `${modelId} cache-write rate ${pricing.cacheWriteUsdPerMillionTokens} is not 1.25x its input rate ${pricing.inputUsdPerMillionTokens}`
    );
    assert.equal(
      pricing.cachedInputPriceMultiplier,
      PROMPT_CACHE_READ_PRICE_MULTIPLIER,
      `${modelId} cache-read multiplier`
    );
  }
});
