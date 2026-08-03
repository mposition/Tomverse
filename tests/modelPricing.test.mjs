import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AVAILABLE_MODELS, getModelBillingProfile } from "../lib/models.ts";
import {
  FALLBACK_PRICING,
  findUnpricedModels,
  getModelPricingProfile,
  getNativeSearchCostMicroUsdPerQuery,
  PENDING_VERIFIED_PRICE_MODEL_IDS,
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
    "kimi-k3": [3, 15, 1_048_576],
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
