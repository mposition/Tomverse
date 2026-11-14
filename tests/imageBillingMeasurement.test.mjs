import assert from "node:assert/strict";
import test from "node:test";

import { measurementApplies, suggestsMeasurement } from "../lib/adminModelCatalogFlow.ts";
import { IMAGE_PROMPT_BUDGET_MICRO_USD as PROMPT } from "../lib/imageGenerationPricing.ts";
import {
  emptyMeasurementForm,
  imageBillingMeasurementEnabled,
  measurementMethodFor,
  measurementPlanFromForm,
  measurementPlanSchema,
  measurementVerdict,
  numericUsage,
  planProblem,
  planWorstCaseMicroUsd,
  sampleCeilingMicroUsd,
  sampleCostMicroUsd,
  sampleRequests,
} from "../lib/imageBillingMeasurementCore.ts";
import {
  billingTermsApplyTo,
  confirmedImageOutputTokens,
  IMAGE_MODEL_REGISTRY,
  imageMeasuredOutputLimitBound,
  imageThinkingBilling,
  imageThinkingCapEnforced,
  imageThinkingCapMinimumMicroUsd,
  minimumCreditsForImageOption,
} from "../lib/imageModelRegistry.ts";
import { judgeImageModel, latestBillingTerms, resolveImageCatalog, reviewImageDraft, withImageBillingTerms } from "../lib/modelCatalogCore.ts";
import { imageDraftFromAnswer } from "../lib/modelCatalogDraftLlm.ts";

// The admin billing measurement (image policy section 12.1) on the three
// models that could not be priced from documentation on 2026-11-13: GPT Image
// 2.6 Flare (per-token, no tokens per image), Gemini Nano Banana 2.1 (thinking
// billed per token) and Wan 2.7 Image (a Qwen model outside qwen-image-).

const NOW = new Date("2026-11-13T12:00:00Z");
const MAX = 5_000_000;

const googlePlan = (maxOutputTokens, samples = 6) =>
  measurementPlanSchema.parse({
    method: "output_limit",
    provider: "google",
    apiModelId: "gemini-nano-banana-2.1",
    maxOutputTokens,
    samples,
    textOutputUsdPerMTok: 7.5,
    imageOutputUsdPerMTok: 30,
    maxCostMicroUsd: MAX,
  });

const flarePlan = measurementPlanSchema.parse({
  method: "tokens_per_image",
  provider: "openai",
  apiModelId: "gpt-image-2.6-flare",
  options: [
    { quality: "low", size: "1024x1024" },
    { quality: "high", size: "1536x1024" },
  ],
  samplesPerOption: 2,
  imageOutputUsdPerMTok: 30,
  maxCostMicroUsd: MAX,
});

const wanPlan = measurementPlanSchema.parse({
  method: "per_image",
  provider: "qwen",
  apiModelId: "wan2.7-image",
  samples: 2,
  perImageUsd: 0.03,
  maxCostMicroUsd: MAX,
});

const sample = (index, fields = {}) => ({
  index,
  quality: "medium",
  size: "1024x1024",
  delivered: true,
  failure: null,
  httpStatus: 200,
  inputTokens: 20,
  outputTokens: null,
  thinkingTokens: 0,
  nonImageBillableTokens: null,
  billedImageTokens: null,
  usage: null,
  width: 1024,
  height: 1024,
  providerRequestId: null,
  costMicroUsd: 0,
  durationMs: 1,
  ...fields,
});

test("measurement is off unless the owner switch is set", () => {
  assert.equal(imageBillingMeasurementEnabled({}), false);
  assert.equal(imageBillingMeasurementEnabled({ IMAGE_BILLING_MEASUREMENT_ENABLED: "0" }), false);
  assert.equal(imageBillingMeasurementEnabled({ IMAGE_BILLING_MEASUREMENT_ENABLED: "1" }), true);
  assert.equal(imageBillingMeasurementEnabled({ IMAGE_BILLING_MEASUREMENT_ENABLED: "true" }), true);
});

test("each provider has its one method; the plan schema refuses a mismatch", () => {
  assert.equal(measurementMethodFor("google"), "output_limit");
  assert.equal(measurementMethodFor("openai"), "tokens_per_image");
  assert.equal(measurementMethodFor("qwen"), "per_image");
  assert.equal(measurementMethodFor("fal"), null);
  assert.equal(
    measurementPlanSchema.safeParse({ ...wanPlan, provider: "google" }).success,
    false
  );
  // At most 12 samples: 5 options x 3 is refused.
  const five = ["low", "medium", "high"].map((quality) => ({ quality, size: "1024x1024" })).concat([{ quality: "low", size: "1536x1024" }, { quality: "high", size: "1536x1024" }]);
  assert.equal(measurementPlanSchema.safeParse({ ...flarePlan, options: five, samplesPerOption: 3 }).success, false);
  assert.equal(measurementPlanSchema.safeParse({ ...flarePlan, options: five, samplesPerOption: 2 }).success, true);
  // More than $10 is never approvable.
  assert.equal(measurementPlanSchema.safeParse({ ...wanPlan, maxCostMicroUsd: 10_000_001 }).success, false);
});

test("a plan's worst case is every sample at its ceiling, and the maximum must cover it", () => {
  const plan = googlePlan(4_096);
  // 2 x 4,096 at $7.50 + 2,500 image tokens at $30 + the prompt budget.
  assert.equal(sampleCeilingMicroUsd(plan), Math.ceil(2 * 4_096 * 7.5 + 2_500 * 30) + PROMPT);
  assert.equal(sampleRequests(plan).length, 6);
  assert.equal(planWorstCaseMicroUsd(plan), 6 * sampleCeilingMicroUsd(plan));
  assert.equal(planProblem(plan), null);
  assert.match(planProblem({ ...plan, maxCostMicroUsd: 100_000 }), /^max_cost_below_worst_case:/);
  assert.equal(sampleRequests(flarePlan).length, 4);
  assert.equal(sampleCeilingMicroUsd(wanPlan), 60_000);
});

test("a sample costs what its usage says, its ceiling when the usage is missing, nothing when refused outright", () => {
  const plan = googlePlan(4_096);
  assert.equal(
    sampleCostMicroUsd(plan, sample(0, { nonImageBillableTokens: 3_000, billedImageTokens: 1_120 })),
    Math.ceil(3_000 * 7.5 + 1_120 * 30) + PROMPT
  );
  assert.equal(sampleCostMicroUsd(plan, sample(0, { delivered: false, httpStatus: null })), sampleCeilingMicroUsd(plan));
  assert.equal(sampleCostMicroUsd(plan, sample(0, { delivered: false, httpStatus: 400 })), 0);
  // A rate limit or timeout is counted at the ceiling: it is not proven free.
  assert.equal(sampleCostMicroUsd(plan, sample(0, { delivered: false, httpStatus: 429 })), sampleCeilingMicroUsd(plan));
  assert.equal(sampleCostMicroUsd(flarePlan, sample(0, { outputTokens: 4_160 })), 124_800 + PROMPT);
  assert.equal(sampleCostMicroUsd(wanPlan, sample(0)), 30_000);
  // A 4xx from downloading a generated image is not a refusal: the image was billed.
  assert.equal(sampleCostMicroUsd(wanPlan, sample(0, { delivered: false, httpStatus: 403, afterGeneration: true })), sampleCeilingMicroUsd(wanPlan));
  assert.equal(sampleCostMicroUsd(wanPlan, sample(0, { delivered: false, httpStatus: 400 })), 0);
});

test("Nano Banana 2.1: limits that lose images cannot be confirmed; a limit that keeps them can", () => {
  // 2026-11-13 production readings: at 2,048 no sample carried an image.
  const at2048 = googlePlan(2_048);
  const lost = Array.from({ length: 6 }, (_, i) =>
    sample(i, { delivered: false, failure: "provider_failed", httpStatus: 200, nonImageBillableTokens: 2_048, billedImageTokens: 0 })
  );
  const v2048 = measurementVerdict(at2048, lost);
  assert.equal(v2048.confirmable, false);
  assert.ok(v2048.reasons.includes("image_missing:6/6"));

  // At 4,096 three of six; every total under the limit.
  const at4096 = googlePlan(4_096);
  const half = Array.from({ length: 6 }, (_, i) =>
    i < 3
      ? sample(i, { nonImageBillableTokens: 3_100, billedImageTokens: 1_120 })
      : sample(i, { delivered: false, failure: "provider_failed", nonImageBillableTokens: 4_000, billedImageTokens: 0 })
  );
  const v4096 = measurementVerdict(at4096, half);
  assert.equal(v4096.confirmable, false);
  assert.deepEqual(v4096.reasons, ["image_missing:3/6"]);

  // A limit where every sample delivers is confirmable, at the limit sent.
  const at8192 = googlePlan(8_192);
  const kept = Array.from({ length: 6 }, (_, i) => sample(i, { nonImageBillableTokens: 5_000 + i, billedImageTokens: 1_120 }));
  const v8192 = measurementVerdict(at8192, kept);
  assert.equal(v8192.confirmable, true);
  assert.deepEqual(v8192.terms, {
    kind: "measured_output_limit",
    maxOutputTokens: 8_192,
    textOutputUsdPerMTok: 7.5,
    imageTokensPerImage: 1_120,
    imageOutputUsdPerMTok: 30,
  });
  // Past twice the limit is not a bound.
  const over = measurementVerdict(at8192, [...kept.slice(0, 5), sample(5, { nonImageBillableTokens: 16_385, billedImageTokens: 1_120 })]);
  assert.equal(over.confirmable, false);
  assert.ok(over.reasons.includes("over_bound:1/6"));
  // Fewer samples than planned is never confirmable.
  assert.ok(measurementVerdict(at8192, kept.slice(0, 4)).reasons.includes("incomplete:4/6"));
});

test("GPT Image 2.6 Flare: the measured tokens per option become the terms; a moving count doubles", () => {
  const steady = [
    sample(0, { quality: "low", size: "1024x1024", outputTokens: 272 }),
    sample(1, { quality: "low", size: "1024x1024", outputTokens: 272 }),
    sample(2, { quality: "high", size: "1536x1024", outputTokens: 6_000 }),
    sample(3, { quality: "high", size: "1536x1024", outputTokens: 6_240 }),
  ];
  const verdict = measurementVerdict(flarePlan, steady);
  assert.equal(verdict.confirmable, true);
  assert.deepEqual(verdict.terms, {
    kind: "tokens_per_image",
    imageOutputUsdPerMTok: 30,
    tokens: [
      { quality: "low", size: "1024x1024", tokens: 272 },
      { quality: "high", size: "1536x1024", tokens: 12_480 },
    ],
  });
  assert.ok(verdict.notes.some((note) => note.startsWith("tokens_vary:high/1536x1024")));
  // One good sample per option is not enough when its sibling failed or reported nothing.
  const partial = measurementVerdict(flarePlan, [steady[0], sample(1, { quality: "low", size: "1024x1024", delivered: false, failure: "provider_failed" }), steady[2], sample(3, { quality: "high", size: "1536x1024", outputTokens: null })]);
  assert.equal(partial.confirmable, false);
  assert.deepEqual(partial.reasons, ["image_missing:1/4", "usage_missing"]);
  const missing = measurementVerdict(flarePlan, [...steady.slice(0, 2), sample(2, { quality: "high", size: "1536x1024", delivered: false, failure: "provider_failed" }), sample(3, { quality: "high", size: "1536x1024", delivered: false, failure: "provider_failed" })]);
  assert.equal(missing.confirmable, false);
  assert.ok(missing.reasons.includes("option_unmeasured:high/1536x1024"));
});

test("Wan 2.7: per-image billing is confirmable only with every image and no generated-token usage", () => {
  const ok = measurementVerdict(wanPlan, [
    sample(0, { usage: { image_count: 1, width: 1024, height: 1024 } }),
    sample(1, { usage: { image_count: 1, width: 1024, height: 1024 } }),
  ]);
  assert.equal(ok.confirmable, true);
  assert.deepEqual(ok.terms, { kind: "per_image_no_thinking" });
  const tokens = measurementVerdict(wanPlan, [
    sample(0, { usage: { image_count: 1, input_tokens: 30, output_tokens: 900 } }),
    sample(1, { usage: { image_count: 1 } }),
  ]);
  assert.equal(tokens.confirmable, false);
  assert.deepEqual(tokens.reasons, ["token_usage_reported:output_tokens"]);
  // A request shape the endpoint rejects (wrong body for Wan) is no image, not a confirmation.
  const rejected = measurementVerdict(wanPlan, [
    sample(0, { delivered: false, failure: "provider_user_error", httpStatus: 400 }),
    sample(1, { delivered: false, failure: "provider_user_error", httpStatus: 400 }),
  ]);
  assert.equal(rejected.confirmable, false);
  assert.equal(rejected.terms, null);
});

test("the admin form becomes a plan with the worst case as the default maximum", () => {
  const form = { ...emptyMeasurementForm(), maxOutputTokens: "8192", samples: "6", textRate: "7.5", imageRate: "30" };
  const { plan, worstCaseMicroUsd, problem } = measurementPlanFromForm("google", "gemini-nano-banana-2.1", form);
  assert.equal(problem, null);
  assert.equal(plan.maxOutputTokens, 8_192);
  assert.ok(plan.maxCostMicroUsd >= worstCaseMicroUsd);
  assert.equal(measurementPlanFromForm("google", "x", { ...form, textRate: "" }).problem, "invalid_plan");
  assert.match(measurementPlanFromForm("google", "x", { ...form, maxCostUsd: "0.10" }).problem, /^max_cost_below_worst_case/);
  assert.equal(measurementPlanFromForm("fal", "x", form).problem, "unsupported");
  const flare = measurementPlanFromForm("openai", "gpt-image-2.6-flare", { ...emptyMeasurementForm(), imageRate: "30" });
  assert.equal(flare.problem, null);
  assert.equal(flare.plan.options.length, 3);
});

test("usage is flattened to numbers only", () => {
  assert.deepEqual(numericUsage({ output_tokens: 5, details: { image_tokens: 4, note: "x" }, list: [1] }), {
    output_tokens: 5,
    "details.image_tokens": 4,
  });
  assert.equal(numericUsage(null), null);
  assert.equal(numericUsage({ note: "x" }), null);
});

// --- the judge and the request read confirmed terms beside the code tables ---

const perImage = { kind: "per_image_no_thinking", confirmationId: "t1" };
const measured = { kind: "measured_output_limit", maxOutputTokens: 8_192, textOutputUsdPerMTok: 7.5, imageTokensPerImage: 1_120, imageOutputUsdPerMTok: 30 };
const flareTerms = {
  kind: "tokens_per_image",
  imageOutputUsdPerMTok: 30,
  tokens: [{ quality: "high", size: "1024x1024", tokens: 4_160 }],
};

test("confirmed terms open only the provider whose request holds them", () => {
  assert.equal(billingTermsApplyTo("qwen", perImage), perImage);
  assert.equal(billingTermsApplyTo("openai", perImage), null);
  assert.equal(billingTermsApplyTo("fal", measured), null);
  // Wan: no bound from the code table, 0 once per-image billing is confirmed.
  assert.equal(imageThinkingCapMinimumMicroUsd("qwen", "wan2.7-image"), null);
  assert.equal(imageThinkingCapMinimumMicroUsd("qwen", "wan2.7-image", perImage), 0);
  assert.equal(imageThinkingBilling("qwen", "wan2.7-image", perImage), "not_billed");
  // Nano Banana 2.1: unbounded, then the measured bound at the text rate.
  assert.equal(imageThinkingCapMinimumMicroUsd("google", "gemini-nano-banana-2.1"), null);
  assert.equal(imageThinkingCapMinimumMicroUsd("google", "gemini-nano-banana-2.1", measured), 2 * 8_192 * 7.5);
  assert.equal(imageThinkingBilling("google", "gemini-nano-banana-2.1", measured), "per_token_within_output_limit");
  // The code table stays the default where nothing is confirmed.
  assert.equal(imageThinkingCapMinimumMicroUsd("google", "gemini-3.1-flash-image"), 12_288);
  assert.equal(confirmedImageOutputTokens("openai", flareTerms, "high", "1024x1024"), 4_160);
  assert.equal(confirmedImageOutputTokens("openai", flareTerms, "low", "1024x1024"), null);
  assert.equal(confirmedImageOutputTokens("google", flareTerms, "high", "1024x1024"), null);
});

const runtimeRow = (modelId, profile) => ({ modelId, enabled: true, holdReason: null, sortOrder: null, profile });
const termsRow = (id, provider, apiModelId, terms, at) => ({ id, provider, apiModelId, terms, createdAt: new Date(at) });

test("the latest confirmed terms win, and a row that does not parse confirms nothing", () => {
  const map = latestBillingTerms([
    termsRow("a", "google", "m", measured, "2026-11-01"),
    termsRow("b", "google", "m", { ...measured, maxOutputTokens: 4_096 }, "2026-11-02"),
    termsRow("c", "qwen", "w", { kind: "per_image_no_thinking", extra: 1 }, "2026-11-02"),
    termsRow("d", "openai", "w", perImage, "2026-11-02"),
  ]);
  assert.equal(map.get("google\u0000m").maxOutputTokens, 4_096);
  assert.equal(map.get("google\u0000m").confirmationId, "b");
  assert.equal(map.get("qwen\u0000w"), null);
  assert.equal(map.get("openai\u0000w"), null);
});

test("a runtime Google model is sent the confirmed limit and the judge admits it at its floor", () => {
  const profile = {
    provider: "google",
    apiModelId: "gemini-nano-banana-2.1",
    name: "Nano Banana 2.1",
    lifecycle: "preview",
    sizes: ["1024x1024"],
    qualities: ["medium"],
    latencyClass: "balanced",
    provenance: ["synthid"],
    outputMimeTypes: ["image/jpeg"],
    deliveryMimeType: "image/jpeg",
    maxOutputTokens: 2_048,
  };
  const cap = 2 * 8_192 * 7.5;
  const verification = { verifiedAt: "2026-11-13", sources: ["https://aistudio.google.com/docs/pricing"], thinkingCapMicroUsd: cap };
  const revision = (credits) => ({
    modelId: "nano-21",
    pricingVersion: "v1",
    prices: [{ quality: "medium", size: "1024x1024", credits, outputCostMicroUsd: 33_600 }],
    verification,
    effectiveFrom: new Date("2026-11-01"),
  });
  const judge = (model) => judgeImageModel(model, { minimumCredits: minimumCreditsForImageOption, providerBudgetReady: () => true });
  const resolve = (billingTerms, credits = 500) =>
    resolveImageCatalog({ seed: IMAGE_MODEL_REGISTRY, rows: [runtimeRow("nano-21", profile)], revisions: [revision(credits)], now: NOW, judge, billingTerms })
      .models.find((model) => model.id === "nano-21");

  assert.equal(resolve([]).disabledReason, "worst_case_cost_unbounded");
  const terms = [termsRow("t", "google", "gemini-nano-banana-2.1", measured, "2026-11-13")];
  const model = resolve(terms);
  assert.equal(model.maxOutputTokens, 8_192);
  assert.equal(model.billingTerms.kind, "measured_output_limit");
  assert.deepEqual(imageMeasuredOutputLimitBound(model), { maxOutputTokens: 8_192, textOutputUsdPerMTok: 7.5, imageTokensPerImage: 1_120 });
  assert.equal(imageThinkingCapEnforced(model), true);
  assert.equal(model.disabledReason, null);
  // Re-measured at twice the image tokens: the 1K price no longer covers one image.
  const doubled = [termsRow("t2", "google", "gemini-nano-banana-2.1", { ...measured, imageTokensPerImage: 2_240 }, "2026-11-14"), ...terms];
  assert.equal(resolve(doubled).disabledReason, "price_unverified");
  // Credits under the floor at the confirmed cap are still refused.
  assert.equal(resolve(terms, 10).disabledReason, "operational_hold");
});

test("a code model keeps its own request: confirmed terms that differ refuse it rather than change it", () => {
  const seed = IMAGE_MODEL_REGISTRY.find((model) => model.apiModelId === "gemini-3.1-flash-image");
  const terms = [termsRow("t", "google", "gemini-3.1-flash-image", measured, "2026-11-13")];
  const judge = (model) => judgeImageModel(model, { minimumCredits: minimumCreditsForImageOption, providerBudgetReady: () => true });
  const resolved = resolveImageCatalog({
    seed: IMAGE_MODEL_REGISTRY,
    rows: [{ modelId: seed.id, enabled: true, holdReason: null, sortOrder: null, profile: null }],
    revisions: [],
    now: NOW,
    judge,
    billingTerms: terms,
  }).models.find((model) => model.id === seed.id);
  assert.equal(resolved.maxOutputTokens, seed.maxOutputTokens);
  assert.equal(resolved.disabledReason, "worst_case_cost_unbounded");
});

test("drafts: Flare is priced from measured tokens, Wan and Nano Banana 2.1 take the confirmed cap", () => {
  const source = ["https://developers.openai.com/api/docs/pricing"];
  const flareAnswer = { options: [], outputUsdPerMTok: 30, thinkingCapMicroUsd: null, noPriceReason: "only per-token rates" };
  // Without a measurement the draft is refused, as in production on 2026-11-13.
  assert.throws(() => imageDraftFromAnswer(flareAnswer, source, "gpt-image-2.6-flare", "openai"), (error) => error.code === "draft_rejected");
  const flare = imageDraftFromAnswer(flareAnswer, source, "gpt-image-2.6-flare", "openai", flareTerms);
  assert.equal(flare.prices.length, 1);
  assert.equal(flare.prices[0].outputCostMicroUsd, 124_800);
  assert.equal(flare.verification.thinkingCapMicroUsd, 0);
  // A larger stated count stands over the measured one.
  const stated = imageDraftFromAnswer(
    { ...flareAnswer, options: [{ quality: "high", size: "1024x1024", outputCostMicroUsd: null, outputTokens: 5_000 }] },
    source,
    "gpt-image-2.6-flare",
    "openai",
    flareTerms
  );
  assert.equal(stated.prices[0].outputCostMicroUsd, 150_000);
  // A documented rate raised since the measurement prices the measured tokens at the new rate.
  const raised = imageDraftFromAnswer({ ...flareAnswer, outputUsdPerMTok: 60 }, source, "gpt-image-2.6-flare", "openai", flareTerms);
  assert.equal(raised.prices[0].outputCostMicroUsd, 249_600);

  const priced = { options: [{ quality: "medium", size: "1024x1024", outputCostMicroUsd: 30_000, outputTokens: null }], outputUsdPerMTok: null, thinkingCapMicroUsd: null, noPriceReason: null };
  const qwenSource = ["https://www.alibabacloud.com/help/en/model-studio/model-pricing"];
  assert.equal(imageDraftFromAnswer(priced, qwenSource, "wan2.7-image", "qwen").verification.thinkingCapMicroUsd, null);
  assert.equal(imageDraftFromAnswer(priced, qwenSource, "wan2.7-image", "qwen", perImage).verification.thinkingCapMicroUsd, 0);
  assert.equal(
    imageDraftFromAnswer(priced, ["https://aistudio.google.com/docs/pricing"], "gemini-nano-banana-2.1", "google", measured).verification
      .thinkingCapMicroUsd,
    2 * 8_192 * 7.5
  );
});

test("the panel offers a measurement for an unbounded or unpriced refusal on a measurable provider", () => {
  assert.equal(suggestsMeasurement("google", ["worst_case_cost_unbounded"]), true);
  assert.equal(suggestsMeasurement("openai", ["draft_rejected"], "no_options: only per-token rates"), true);
  assert.equal(suggestsMeasurement("qwen", ["credits_below_floor:low/1024x1024"]), false);
  assert.equal(suggestsMeasurement("fal", ["worst_case_cost_unbounded"]), false);
  // A model that already serves a cap of its own takes a new draft, not a measurement.
  const flash = { provider: "google", served: { priceVerification: { thinkingCapMicroUsd: 12_288 } } };
  assert.equal(measurementApplies(flash, ["worst_case_cost_unbounded"]), false);
  const pro = { provider: "google", served: { priceVerification: { thinkingCapMicroUsd: null } } };
  assert.equal(measurementApplies(pro, ["worst_case_cost_unbounded"]), true);
  assert.equal(measurementApplies({ provider: "qwen", served: null }, ["worst_case_cost_unbounded"]), true);
});

test("a price older than the confirmed tokens per image is refused until a new draft", () => {
  const profile = {
    provider: "openai",
    apiModelId: "gpt-image-2.6-flare",
    name: "Flare",
    lifecycle: "preview",
    sizes: ["1024x1024"],
    qualities: ["high"],
    latencyClass: "balanced",
    provenance: ["c2pa"],
    outputMimeTypes: ["image/png"],
  };
  const revision = (outputCostMicroUsd) => ({
    modelId: "flare",
    pricingVersion: "v1",
    prices: [{ quality: "high", size: "1024x1024", credits: 400, outputCostMicroUsd }],
    verification: { verifiedAt: "2026-11-13", sources: ["https://developers.openai.com/api/docs/pricing"], thinkingCapMicroUsd: 0 },
    effectiveFrom: new Date("2026-11-01"),
  });
  const judge = (model) => judgeImageModel(model, { minimumCredits: minimumCreditsForImageOption, providerBudgetReady: () => true });
  const resolve = (cost, tokens) =>
    resolveImageCatalog({
      seed: IMAGE_MODEL_REGISTRY,
      rows: [runtimeRow("flare", profile)],
      revisions: [revision(cost)],
      now: NOW,
      judge,
      billingTerms: [termsRow("t", "openai", "gpt-image-2.6-flare", { ...flareTerms, tokens: [{ quality: "high", size: "1024x1024", tokens }] }, "2026-11-13")],
    }).models.find((model) => model.id === "flare");
  assert.equal(resolve(124_800, 4_160).disabledReason, null);
  // Re-measured at twice the tokens: the served price no longer covers it.
  const stale = resolve(124_800, 8_320);
  assert.equal(stale.disabledReason, "price_unverified");
  assert.ok(judge({ ...stale, disabledReason: null }).reasons.includes("price_below_measured_cost:high/1024x1024"));
});

test("an enabled code model with no row is judged again once terms are confirmed for it", () => {
  const seed = IMAGE_MODEL_REGISTRY.find((model) => model.id === "gpt-image-2");
  const high = seed.prices.find((price) => price.quality === "high" && price.size === "1024x1024");
  const judge = (model) => judgeImageModel(model, { minimumCredits: minimumCreditsForImageOption, providerBudgetReady: () => true });
  const resolve = (tokens) =>
    resolveImageCatalog({
      seed: IMAGE_MODEL_REGISTRY,
      rows: [],
      revisions: [],
      now: NOW,
      judge,
      billingTerms: [
        termsRow("t", "openai", "gpt-image-2", { kind: "tokens_per_image", imageOutputUsdPerMTok: 30, tokens: [{ quality: "high", size: "1024x1024", tokens }] }, "2026-11-13"),
      ],
    }).models.find((model) => model.id === seed.id);
  // Terms the seed price covers keep it serving; terms it does not cover hold it.
  assert.equal(resolve(Math.floor(high.outputCostMicroUsd / 30)).disabledReason, null);
  assert.equal(resolve(Math.ceil(high.outputCostMicroUsd / 30) * 2).disabledReason, "price_unverified");
});

test("a draft made after confirming terms is one the judge admits, for Google and OpenAI", () => {
  const base = (provider, apiModelId, extra = {}) => ({
    id: apiModelId,
    provider,
    apiModelId,
    name: apiModelId,
    lifecycle: "preview",
    sizes: ["1024x1024"],
    qualities: ["medium", "high"],
    latencyClass: "balanced",
    provenance: [],
    outputMimeTypes: ["image/jpeg"],
    disabledReason: null,
    prices: [],
    pricingVersion: "unpriced",
    priceVerification: { verifiedAt: null, sources: [], thinkingCapMicroUsd: null },
    ...extra,
  });
  const review = (model, terms, draft) =>
    reviewImageDraft(withImageBillingTerms(model, latestBillingTerms(terms), { runtime: true }), draft, { minimumCredits: minimumCreditsForImageOption });

  // Google: the pages say $0.030 for a 1K image, the measurement found 1,120 tokens at $30/1M.
  const googleSource = ["https://aistudio.google.com/docs/pricing"];
  const nano = imageDraftFromAnswer(
    { options: [{ quality: "medium", size: "1024x1024", outputCostMicroUsd: 30_000, outputTokens: null }], outputUsdPerMTok: null, thinkingCapMicroUsd: null, noPriceReason: null },
    googleSource,
    "gemini-nano-banana-2.1",
    "google",
    measured
  );
  assert.equal(nano.prices[0].outputCostMicroUsd, 33_600);
  const nanoReview = review(base("google", "gemini-nano-banana-2.1", { maxOutputTokens: 2_048 }), [termsRow("t", "google", "gemini-nano-banana-2.1", measured, "2026-11-13")], nano);
  assert.deepEqual(nanoReview.reasons, []);

  // OpenAI: no per-image price on the pages, measured tokens at the documented rate.
  const flare = imageDraftFromAnswer(
    { options: [], outputUsdPerMTok: 30, thinkingCapMicroUsd: null, noPriceReason: "only per-token rates" },
    ["https://developers.openai.com/api/docs/pricing"],
    "gpt-image-2.6-flare",
    "openai",
    flareTerms
  );
  const flareReview = review(base("openai", "gpt-image-2.6-flare", { outputMimeTypes: ["image/png"] }), [termsRow("t", "openai", "gpt-image-2.6-flare", flareTerms, "2026-11-13")], flare);
  assert.deepEqual(flareReview.reasons, []);
});
