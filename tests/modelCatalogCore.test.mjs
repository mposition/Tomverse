import assert from "node:assert/strict";
import test from "node:test";

import {
  IMAGE_MODEL_REGISTRY,
  getImageModel,
  listEnabledImageModels,
  minimumCreditsForImageOption,
  resetActiveImageModelCatalog,
  setActiveImageModelCatalog,
} from "../lib/imageModelRegistry.ts";
import {
  canonicalJson,
  catalogContentHash,
  decideSnapshotRenewal,
  effectiveRevisions,
  imageExecutionDrift,
  imageExecutionProfile,
  isOfficialSourceUrl,
  codingModelPage,
  DEFAULT_CODING_CAPABILITY_SOURCES,
  DEFAULT_PRICE_SOURCES,
  defaultCodingCapabilitySources,
  defaultPriceSources,
  OFFICIAL_SOURCE_HOSTS,
  judgeCodingModel,
  judgeImageModel,
  judgeVideoModel,
  MODEL_CATALOG_CATEGORIES,
  resolveImageCatalog,
  snapshotCoverageUntil,
  snapshotIsCurrent,
  SNAPSHOT_RENEWAL_WINDOW_MS,
  stalePricingVersions,
  applyImageCreditOverrides,
  freePricingVersion,
  imageCreditOverrideSchema,
  reviewImageDraft,
  CODING_DEFAULT_MAX_OUTPUT_TOKENS,
  CODING_STRUCTURED_OUTPUT,
  CODING_STRUCTURED_OUTPUT_CHOICES,
  codingNotesSchema,
  codingNotesRouterText,
  codingDraftBasisSchema,
  codingPriceTiersSchema,
  codingProfileForWrite,
  codingProfileSchema,
  codingStoredProfileSchema,
  codingStructuredOutputChoice,
} from "../lib/modelCatalogCore.ts";
import { APICallError } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import {
  BenchmarkSearchOutcomeUnknown,
  benchmarkPageSearchWith,
  benchmarkPageSearchFromEnv,
  benchmarkSearchPrompt,
  benchmarkUrlsFromAnswer,
  BENCHMARK_SEARCH_SCHEMA,
  CAPABILITY_SCHEMA,
  CAPABILITY_TASK,
  CODING_SCHEMA,
  CODING_TASK,
  codingCapabilitiesFromAnswer,
  codingDraftFromAnswer,
  draftPricingVersion,
  imageDraftFromAnswer,
  imageOptionCostMicroUsd,
  MAX_DRAFT_SOURCES,
  pageToText,
} from "../lib/modelCatalogDraftLlm.ts";
import { AI_PROVIDERS } from "../lib/modelRegistryShared.ts";

const NOW = new Date("2026-10-19T12:00:00Z");
const enabledSeed = IMAGE_MODEL_REGISTRY.find((model) => model.disabledReason === null);
const heldSeed = IMAGE_MODEL_REGISTRY.find((model) => model.disabledReason === "worst_case_cost_unbounded");

const judge = (budgetReady = true) => (model) =>
  judgeImageModel(model, {
    minimumCredits: minimumCreditsForImageOption,
    providerBudgetReady: () => budgetReady,
  });

const resolve = (rows, revisions = [], budgetReady = true) =>
  resolveImageCatalog({ seed: IMAGE_MODEL_REGISTRY, rows, revisions, now: NOW, judge: judge(budgetReady) });

const row = (modelId, fields = {}) => ({
  modelId,
  enabled: null,
  holdReason: null,
  sortOrder: null,
  profile: null,
  ...fields,
});

test("the categories are chat, image, coding and video; video has no activation policy", () => {
  assert.deepEqual([...MODEL_CATALOG_CATEGORIES], ["chat", "image", "coding", "video"]);
  assert.deepEqual(judgeVideoModel(), { admitted: false, reasons: ["no_activation_policy"] });
});

test("no rows: the resolved catalogue is exactly the code seed", () => {
  const { models, problems } = resolve([]);
  assert.deepEqual(models, IMAGE_MODEL_REGISTRY);
  assert.deepEqual(problems, []);
});

test("NULL inherits, a hold disables, and an override changes only what it names", () => {
  const { models } = resolve([
    row(enabledSeed.id, { holdReason: "provider incident", profile: { name: "Renamed" } }),
  ]);
  const model = models.find((m) => m.id === enabledSeed.id);
  assert.equal(model.disabledReason, "operational_hold");
  // The operator's note stays on the admin surface; browsers get the code note.
  assert.equal(model.disabledNote, enabledSeed.disabledNote);
  assert.equal(model.name, "Renamed");
  assert.deepEqual(model.prices, enabledSeed.prices);
  assert.equal(model.pricingVersion, enabledSeed.pricingVersion);
});

test("turning on a model whose worst case is unbounded is refused by the judge, not by the row", () => {
  const { models } = resolve([row(heldSeed.id, { enabled: true })]);
  assert.equal(models.find((m) => m.id === heldSeed.id).disabledReason, "worst_case_cost_unbounded");
});

test("a thinking cap stated for a provider whose request cannot hold it does not unbound the hold", () => {
  // Google bills thinking per token with no request parameter that caps it.
  // A revision may still write a number into thinkingCapMicroUsd; turning the
  // model on with that number must not reserve less than the call can spend.
  const googleRevision = (modelId) => ({
    modelId,
    pricingVersion: `${modelId}-stated-cap`,
    effectiveFrom: new Date("2026-10-19T00:00:00Z"),
    prices: [{ quality: "medium", size: "1024x1024", credits: 10_000, outputCostMicroUsd: 67_000 }],
    verification: {
      verifiedAt: "2026-10-19",
      sources: ["https://ai.google.dev/gemini-api/docs/pricing"],
      thinkingCapMicroUsd: 2_000,
    },
  });

  const seeded = resolve([row(heldSeed.id, { enabled: true })], [googleRevision(heldSeed.id)]);
  assert.equal(heldSeed.provider, "google");
  assert.equal(seeded.models.find((m) => m.id === heldSeed.id).disabledReason, "worst_case_cost_unbounded");

  const profile = {
    provider: "google",
    apiModelId: "gemini-runtime-image",
    name: "Runtime Gemini Image",
    lifecycle: "preview",
    sizes: ["1024x1024"],
    qualities: ["medium"],
    latencyClass: "balanced",
    provenance: ["synthid"],
    outputMimeTypes: ["image/jpeg"],
    maxOutputTokens: 32_768,
  };
  const runtime = resolve(
    [row("gemini-runtime-image", { profile, enabled: true })],
    [googleRevision("gemini-runtime-image")]
  );
  assert.equal(
    runtime.models.find((m) => m.id === "gemini-runtime-image").disabledReason,
    "worst_case_cost_unbounded"
  );

  // The same judge admits fal's flat high-thinking surcharge as a bound.
  const fal = IMAGE_MODEL_REGISTRY.find((model) => model.provider === "fal");
  assert.deepEqual(judge()(fal), { admitted: true });
  const statedGoogle = {
    ...heldSeed,
    disabledReason: null,
    prices: googleRevision(heldSeed.id).prices,
    priceVerification: googleRevision(heldSeed.id).verification,
  };
  assert.ok(judge()(statedGoogle).reasons.includes("worst_case_cost_unbounded"));
});

test("a measured Google model serves on its measured bound and only with the measured request", () => {
  // Owner decision 2026-11-13: Flash's thinking cap is twice the 2,048 output
  // limit the request sends, at $3.00 per 1M -- 12,288 microUSD, floor 94.
  const flash = IMAGE_MODEL_REGISTRY.find((model) => model.id === "gemini-3.1-flash-image");
  const revision = (credits, cap, modelId = flash.id) => ({
    modelId,
    pricingVersion: `${modelId}-${credits}-${cap}`,
    effectiveFrom: new Date("2026-10-19T00:00:00Z"),
    prices: [{ quality: "medium", size: "1024x1024", credits, outputCostMicroUsd: 67_200 }],
    verification: {
      verifiedAt: "2026-10-19",
      sources: ["https://ai.google.dev/gemini-api/docs/pricing"],
      thinkingCapMicroUsd: cap,
    },
  });
  const served = (rows, revisions, id = flash.id) => resolve(rows, revisions).models.find((m) => m.id === id);

  // Held as shipped, and still held when priced but not turned on.
  assert.equal(served([], []).disabledReason, "operational_hold");
  assert.equal(served([], [revision(94, 12_288)]).disabledReason, "operational_hold");
  assert.equal(served([row(flash.id, { enabled: true })], [revision(94, 12_288)]).disabledReason, null);
  // Below the floor, or with a cap under the bound, it does not serve.
  assert.notEqual(served([row(flash.id, { enabled: true })], [revision(93, 12_288)]).disabledReason, null);
  assert.equal(
    served([row(flash.id, { enabled: true })], [revision(10_000, 12_287)]).disabledReason,
    "worst_case_cost_unbounded"
  );
  // No budget, no service.
  assert.notEqual(
    resolve([row(flash.id, { enabled: true })], [revision(94, 12_288)], false).models.find((m) => m.id === flash.id).disabledReason,
    null
  );

  // A runtime row for the same API model that sends another limit, or pins a
  // thinking level, is not the request that was measured.
  const profile = (extra) => ({
    provider: "google",
    apiModelId: flash.apiModelId,
    name: "Runtime Flash",
    lifecycle: "stable",
    sizes: ["1024x1024"],
    qualities: ["medium"],
    latencyClass: "fast",
    provenance: ["synthid"],
    outputMimeTypes: ["image/jpeg"],
    deliveryMimeType: "image/jpeg",
    ...extra,
  });
  const runtime = (extra) =>
    served([row("flash-runtime", { profile: profile(extra), enabled: true })], [revision(94, 12_288, "flash-runtime")], "flash-runtime");
  assert.equal(runtime({ maxOutputTokens: 2_048 }).disabledReason, null);
  assert.equal(runtime({ maxOutputTokens: 32_768 }).disabledReason, "worst_case_cost_unbounded");
  assert.equal(runtime({}).disabledReason, "worst_case_cost_unbounded");
  assert.equal(runtime({ maxOutputTokens: 2_048, thinkingLevel: "high" }).disabledReason, "worst_case_cost_unbounded");
  const refused = judge()({
    ...flash,
    disabledReason: null,
    maxOutputTokens: 32_768,
    prices: revision(94, 12_288).prices,
    priceVerification: revision(94, 12_288).verification,
  });
  assert.ok(refused.reasons.includes("measured_request_required:max_output_tokens_2048_no_thinking_level"));
});

test("a fal revision whose thinking cap is below the pinned surcharge does not serve", () => {
  // Review finding 2026-10-21: the request still pays fal's $0.002 for high
  // thinking, so a cap of 0 would reserve and settle 2,000 less than fal bills.
  const fal = IMAGE_MODEL_REGISTRY.find((model) => model.provider === "fal");
  const understated = {
    modelId: fal.id,
    pricingVersion: "fal-understated-cap",
    effectiveFrom: new Date("2026-10-19T00:00:00Z"),
    prices: fal.prices,
    verification: { ...fal.priceVerification, thinkingCapMicroUsd: 0 },
  };
  const { models } = resolve([], [understated]);
  assert.equal(models.find((m) => m.id === fal.id).disabledReason, "worst_case_cost_unbounded");
  const reasons = judge()({ ...fal, priceVerification: understated.verification }).reasons;
  assert.ok(reasons.includes("worst_case_cost_unbounded"));
  assert.ok(reasons.includes("thinking_cap_below_minimum:2000"));
});

test("a runtime fal model is judged by its endpoint's row, and an unlisted endpoint never serves", () => {
  // Lookup 2026-11-07: fal bills per endpoint. The judge used to read Nano
  // Banana 2's flat surcharge as every fal model's bound.
  const falProfile = (apiModelId) => ({
    provider: "fal",
    apiModelId,
    name: apiModelId,
    lifecycle: "preview",
    sizes: ["1024x1024"],
    qualities: ["medium"],
    latencyClass: "balanced",
    provenance: [],
    outputMimeTypes: ["image/png"],
  });
  // Hypothetical prices for the judge's arithmetic, not approved ones.
  const falRevision = (modelId, thinkingCapMicroUsd) => ({
    modelId,
    pricingVersion: `${modelId}-test`,
    effectiveFrom: new Date("2026-10-19T00:00:00Z"),
    prices: [{ quality: "medium", size: "1024x1024", credits: 200, outputCostMicroUsd: 40_000 }],
    verification: {
      verifiedAt: "2026-11-07",
      sources: [`https://fal.ai/models/${modelId}`],
      thinkingCapMicroUsd,
    },
  });
  const judged = (modelId, cap) => {
    const { models } = resolve(
      [row(modelId, { profile: falProfile(modelId), enabled: true })],
      [falRevision(modelId, cap)]
    );
    return models.find((m) => m.id === modelId);
  };

  // Qwen Image 3 is priced per image: a cap of 0 bounds it and it serves.
  assert.equal(judged("alibaba/qwen-image-3/text-to-image", 0).disabledReason, null);

  // Nano Banana 2.1 is token-billed with no cap parameter. No stated cap --
  // Nano Banana 2's 2,000 or anything larger -- turns that into a bound, and
  // there is no surcharge minimum for it to fall short of.
  for (const cap of [0, 2_000, 1_000_000]) {
    assert.equal(judged("google/nano-banana-2.1", cap).disabledReason, "worst_case_cost_unbounded", String(cap));
  }
  const tokenBilled = judge()({
    ...IMAGE_MODEL_REGISTRY.find((model) => model.provider === "fal"),
    id: "google/nano-banana-2.1",
    apiModelId: "google/nano-banana-2.1",
  });
  assert.ok(tokenBilled.reasons.includes("worst_case_cost_unbounded"));
  assert.equal(tokenBilled.reasons.some((reason) => reason.startsWith("thinking_cap_below_minimum")), false);

  // An endpoint the table does not list is refused, however its revision reads.
  assert.equal(judged("fal-ai/flux/dev", 2_000).disabledReason, "worst_case_cost_unbounded");
});

test("turning on an admitted model serves it; a missing provider budget refuses it", () => {
  const on = resolve([row(enabledSeed.id, { enabled: true })]);
  assert.equal(on.models.find((m) => m.id === enabledSeed.id).disabledReason, null);
  const noBudget = resolve([row(enabledSeed.id, { enabled: true })], [], false);
  assert.notEqual(noBudget.models.find((m) => m.id === enabledSeed.id).disabledReason, null);
});

const revision = (modelId, pricingVersion, effectiveFrom, credits = 50) => ({
  modelId,
  pricingVersion,
  effectiveFrom: new Date(effectiveFrom),
  prices: [{ quality: "low", size: "1024x1024", credits, outputCostMicroUsd: 6_000 }],
  verification: {
    verifiedAt: "2026-10-19",
    sources: ["https://developers.openai.com/api/docs/pricing"],
    thinkingCapMicroUsd: 0,
  },
});

test("the effective price is the latest revision already in force; a future one waits", () => {
  const past = revision(enabledSeed.id, "v-past", "2026-10-01T00:00:00Z");
  const later = revision(enabledSeed.id, "v-later", "2026-10-10T00:00:00Z");
  const future = revision(enabledSeed.id, "v-future", "2026-11-01T00:00:00Z");
  assert.equal(effectiveRevisions([past, future, later], NOW).get(enabledSeed.id).pricingVersion, "v-later");
  const { models } = resolve([], [past, future, later]);
  const model = models.find((m) => m.id === enabledSeed.id);
  assert.equal(model.pricingVersion, "v-later");
  assert.equal(model.prices.length, 1);
});

test("a malformed revision withholds the model instead of serving the old price under a new label", () => {
  const broken = { ...revision(enabledSeed.id, "v-broken", "2026-10-01T00:00:00Z"), prices: [{ quality: "ultra" }] };
  const { models, problems } = resolve([], [broken]);
  assert.equal(models.some((m) => m.id === enabledSeed.id), false);
  assert.deepEqual(problems, [{ modelId: enabledSeed.id, problem: "invalid_price_revision" }]);
});

test("a model that exists only in the database needs a full profile and a price", () => {
  const profile = {
    provider: "openai",
    apiModelId: "gpt-image-3",
    name: "GPT Image 3",
    lifecycle: "preview",
    sizes: ["1024x1024"],
    qualities: ["low"],
    latencyClass: "balanced",
    provenance: ["c2pa"],
    outputMimeTypes: ["image/png"],
  };
  const unpriced = resolve([row("gpt-image-3", { profile, enabled: true })]);
  assert.equal(unpriced.models.some((m) => m.id === "gpt-image-3"), false);
  assert.deepEqual(unpriced.problems, [{ modelId: "gpt-image-3", problem: "no_price_revision" }]);

  const priced = resolve(
    [row("gpt-image-3", { profile, enabled: true })],
    [revision("gpt-image-3", "gpt-image-3-v1", "2026-10-19T00:00:00Z")]
  );
  const added = priced.models.find((m) => m.id === "gpt-image-3");
  assert.equal(added.disabledReason, null);
  assert.equal(added.provider, "openai");
});

test("a runtime Qwen model serves only with Qwen's own source, credits at the floor and a budget", () => {
  const profile = {
    provider: "qwen",
    apiModelId: "qwen-image-2.0",
    name: "Qwen Image 2.0",
    lifecycle: "preview",
    sizes: ["1024x1024"],
    qualities: ["medium"],
    latencyClass: "balanced",
    provenance: [],
    outputMimeTypes: ["image/png"],
  };
  // Test figures, not a sale price: the $0.035 image plus the 5,000 prompt
  // budget is a 40,000 worst case, so the floor is ceil(40,000 / 900) = 45.
  const qwenRevision = (credits, sources = ["https://www.alibabacloud.com/help/en/model-studio/model-pricing"]) => ({
    modelId: "qwen-image-2.0",
    pricingVersion: `qwen-image-2-0-test-${credits}-${sources.length}`,
    effectiveFrom: new Date("2026-10-19T00:00:00Z"),
    prices: [{ quality: "medium", size: "1024x1024", credits, outputCostMicroUsd: 35_000 }],
    verification: { verifiedAt: "2026-11-07", sources, thinkingCapMicroUsd: 0 },
  });
  const served = (revisions, budgetReady = true) =>
    resolve([row("qwen-image-2.0", { profile, enabled: true })], revisions, budgetReady).models.find(
      (m) => m.id === "qwen-image-2.0"
    );

  const atFloor = served([qwenRevision(45)]);
  assert.equal(minimumCreditsForImageOption(atFloor, atFloor.prices[0]), 45);
  assert.equal(atFloor.disabledReason, null);
  assert.equal(atFloor.provider, "qwen");
  assert.deepEqual(judge()(atFloor), { admitted: true });

  // The default-off switch: no provider budget, no service.
  assert.notEqual(served([qwenRevision(45)], false).disabledReason, null);
  assert.deepEqual(judge(false)(atFloor).reasons, ["provider_budget_missing"]);

  assert.notEqual(served([qwenRevision(44)]).disabledReason, null);
  assert.ok(judge()({ ...atFloor, prices: qwenRevision(44).prices }).reasons.includes("credits_below_floor:medium/1024x1024"));
  // Another provider's documentation is not Qwen's price.
  assert.equal(
    served([qwenRevision(45, ["https://developers.openai.com/api/docs/pricing"])]).disabledReason,
    "price_unverified"
  );
  // A Qwen model outside the family whose per-image billing was read has no
  // proven bound, even with a zero cap stated.
  assert.ok(judge()({ ...atFloor, apiModelId: "z-image-turbo" }).reasons.includes("worst_case_cost_unbounded"));
});

test("a revision below the floor never serves, even when the row says inherit or there is no row", () => {
  // Review finding 2026-10-19: the judge used to run only for enabled: true.
  const cheap = {
    ...revision(enabledSeed.id, "v-floor", "2026-10-01T00:00:00Z", 1),
    prices: [{ quality: "high", size: "1024x1024", credits: 1, outputCostMicroUsd: 2_000_000 }],
  };
  for (const rows of [[], [row(enabledSeed.id, { enabled: null })]]) {
    const { models } = resolve(rows, [cheap]);
    assert.notEqual(models.find((m) => m.id === enabledSeed.id).disabledReason, null);
  }
});

test("revisions with the same effectiveFrom resolve the same way everywhere: the later write wins", () => {
  const at = "2026-10-01T00:00:00Z";
  const a = { ...revision(enabledSeed.id, "v-a", at), createdAt: new Date("2026-09-30T00:00:00Z") };
  const b = { ...revision(enabledSeed.id, "v-b", at), createdAt: new Date("2026-09-30T00:00:01Z") };
  assert.equal(effectiveRevisions([a, b], NOW).get(enabledSeed.id).pricingVersion, "v-b");
  assert.equal(effectiveRevisions([b, a], NOW).get(enabledSeed.id).pricingVersion, "v-b");
});

test("credits below the policy floor are refused", () => {
  const cheap = revision(enabledSeed.id, "v-cheap", "2026-10-01T00:00:00Z", 1);
  const { models } = resolve([row(enabledSeed.id, { enabled: true })], [cheap]);
  assert.notEqual(models.find((m) => m.id === enabledSeed.id).disabledReason, null);
});

test("sources must be the provider's own https documentation", () => {
  assert.equal(isOfficialSourceUrl("openai", "https://developers.openai.com/pricing"), true);
  assert.equal(isOfficialSourceUrl("openai", "http://developers.openai.com/pricing"), false);
  assert.equal(isOfficialSourceUrl("openai", "https://openai.com.example.org/pricing"), false);
  assert.equal(isOfficialSourceUrl("openai", "https://ai.google.dev/pricing"), false);
  // Exact hosts: a user forum on a provider subdomain is not documentation.
  assert.equal(isOfficialSourceUrl("openai", "https://community.openai.com/t/1"), false);
  assert.equal(isOfficialSourceUrl("openai", "https://openai.com:8443/pricing"), false);
  // A provider name that is an Object prototype key is unknown, not a crash.
  assert.equal(isOfficialSourceUrl("toString", "https://openai.com/x"), false);
  assert.equal(isOfficialSourceUrl("constructor", "https://openai.com/x"), false);
  // Google's Gemini API docs moved to AI Studio, under /docs/ only: the rest
  // of that host is user-built apps and shared prompts.
  assert.equal(isOfficialSourceUrl("google", "https://aistudio.google.com/docs/pricing"), true);
  assert.equal(isOfficialSourceUrl("google", "https://aistudio.google.com/apps/shared-app"), false);
  assert.equal(isOfficialSourceUrl("google", "https://aistudio.google.com/docsx/pricing"), false);
  assert.equal(isOfficialSourceUrl("google", "https://aistudio.google.com/docs/../apps/x"), false);
  assert.equal(isOfficialSourceUrl("google", "https://ai.google.dev/gemini-api/docs/pricing"), true);
  // QwenCloud: pricing path and the docs host only.
  assert.equal(isOfficialSourceUrl("qwen", "https://www.qwencloud.com/pricing/api?region=ap-southeast-1"), true);
  assert.equal(isOfficialSourceUrl("qwen", "https://docs.qwencloud.com/developer-guides/getting-started/model-prices"), true);
  assert.equal(isOfficialSourceUrl("qwen", "https://www.qwencloud.com/models"), false);
  assert.equal(isOfficialSourceUrl("qwen", "https://qwencloud.com/pricing/api"), false);
  assert.equal(isOfficialSourceUrl("openai", "https://www.qwencloud.com/pricing/api"), false);
});

test("default price sources are official for their provider and fit the draft limit", () => {
  for (const [provider, urls] of Object.entries(DEFAULT_PRICE_SOURCES)) {
    assert.ok(urls.length >= 1 && urls.length <= MAX_DRAFT_SOURCES, provider);
    for (const url of urls) assert.equal(isOfficialSourceUrl(provider, url), true, url);
  }
  assert.deepEqual(defaultPriceSources("qwen"), ["https://www.alibabacloud.com/help/en/model-studio/model-pricing"]);
  assert.deepEqual(defaultPriceSources("toString"), []);
  assert.deepEqual(defaultPriceSources("unknown"), []);
});

test("every chat draft provider has an official tool calling and structured output page", () => {
  const draftProviders = AI_PROVIDERS.filter((provider) => Object.hasOwn(OFFICIAL_SOURCE_HOSTS, provider));
  assert.deepEqual(Object.keys(DEFAULT_CODING_CAPABILITY_SOURCES).sort(), [...draftProviders].sort());
  for (const [provider, sources] of Object.entries(DEFAULT_CODING_CAPABILITY_SOURCES)) {
    assert.notEqual(sources.toolCalling, sources.structuredOutput, provider);
    for (const url of [sources.toolCalling, sources.structuredOutput, codingModelPage(sources, "model-1.5")]) {
      assert.equal(isOfficialSourceUrl(provider, url), true, url);
    }
  }
  // A models page with a page per model names the API model id; an overview is the same for every model.
  assert.equal(codingModelPage(DEFAULT_CODING_CAPABILITY_SOURCES.openai, "gpt-6.1-terra"), "https://developers.openai.com/api/docs/models/gpt-6.1-terra.md");
  assert.equal(codingModelPage(DEFAULT_CODING_CAPABILITY_SOURCES.openai, "a/b"), "https://developers.openai.com/api/docs/models/a%2Fb.md");
  assert.equal(codingModelPage(DEFAULT_CODING_CAPABILITY_SOURCES.anthropic, "claude-x"), DEFAULT_CODING_CAPABILITY_SOURCES.anthropic.models);
  assert.equal(defaultCodingCapabilitySources("toString"), null);
  assert.equal(defaultCodingCapabilitySources("openrouter"), null);
  // The hosts the capability pages need: the Claude docs path and Cohere's docs host.
  assert.equal(isOfficialSourceUrl("anthropic", "https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview.md"), true);
  assert.equal(isOfficialSourceUrl("cohere", "https://docs.cohere.com/docs/tool-use-overview"), true);
});

test("a capability answer is read conservatively: an unknown value is none, and the sources are the pages that were fetched", () => {
  const sources = ["https://developers.openai.com/api/docs/guides/function-calling"];
  const draft = codingCapabilitiesFromAnswer({ toolCalling: "parallel", structuredOutput: "made_up", note: " a  b " }, sources);
  assert.equal(draft.toolCalling, "parallel");
  assert.equal(draft.structuredOutput, "none");
  assert.equal(draft.note, "a b");
  assert.deepEqual(draft.sources, sources);
  assert.deepEqual(
    [codingCapabilitiesFromAnswer(null, sources).toolCalling, codingCapabilitiesFromAnswer({ toolCalling: 5 }, sources).toolCalling],
    ["none", "none"]
  );
  assert.match(draft.draftedAt, /^\d{4}-\d{2}-\d{2}$/);
});

test("only documentation on a provider's own host is official", () => {
  // platform.claude.com also serves the Console; only /docs/ there is documentation.
  assert.equal(isOfficialSourceUrl("anthropic", "https://platform.claude.com/settings/keys"), false);
  assert.equal(isOfficialSourceUrl("anthropic", "https://platform.claude.com/docs/en/about-claude/pricing"), true);
  assert.equal(AI_PROVIDERS.some((provider) => Object.hasOwn(OFFICIAL_SOURCE_HOSTS, provider)), true);
});

test("the registry lookups read the active catalogue and fall back to the seed", () => {
  try {
    setActiveImageModelCatalog([]);
    assert.equal(getImageModel(enabledSeed.id), null);
    assert.deepEqual(listEnabledImageModels(), []);
  } finally {
    resetActiveImageModelCatalog();
  }
  assert.equal(getImageModel(enabledSeed.id)?.id, enabledSeed.id);
});

const codingProfile = (overrides = {}) => ({
  name: "GPT Coding",
  provider: "openai",
  apiModelId: "gpt-coding",
  minimumPlan: "Pro",
  capabilities: { toolCalling: "parallel", structuredOutput: "strict_schema", imageInput: true, maxContextTokens: 400_000, maxOutputTokens: 64_000 },
  pricing: { inputUsdPerMTok: 1, outputUsdPerMTok: 8, creditWeight: 4, verifiedAt: "2026-10-19", sources: ["https://developers.openai.com/pricing"] },
  ...overrides,
});

const codingDeps = (established = true, floor = 1) => ({
  knownProvider: (p) => p === "openai",
  providerDestinationEstablished: () => established,
  creditFloor: () => floor,
});

test("a coding model needs an established data destination, official prices and a credit floor, and no provider conditions", () => {
  assert.deepEqual(judgeCodingModel(codingProfile(), codingDeps()), { admitted: true });
  // Terms that deny, or pages that are not the provider's, are not looked at (owner decision 2026-11-21).
  const withTerms = codingProfile({
    terms: { allowsResaleAndCodingAgent: false, url: "https://someblog.example/terms", checkedAt: "2026-10-19" },
    retention: { url: "https://someblog.example/openai", checkedAt: "2026-10-19" },
    processingRegion: "US",
  });
  assert.deepEqual(judgeCodingModel(withTerms, codingDeps()), { admitted: true });
  assert.ok(judgeCodingModel(codingProfile(), codingDeps(false)).reasons.includes("provider_destination_unproven"));
  assert.ok(judgeCodingModel(codingProfile(), { ...codingDeps(), knownProvider: () => false }).reasons.includes("unknown_provider"));
  const blog = judgeCodingModel(
    codingProfile({ pricing: { ...codingProfile().pricing, sources: ["https://someblog.example/openai"] } }),
    codingDeps()
  );
  assert.ok(blog.reasons.includes("unofficial_price_source:https://someblog.example/openai"));
  assert.ok(judgeCodingModel(codingProfile({ capabilities: { ...codingProfile().capabilities, toolCalling: "none" } }), codingDeps()).reasons.includes("no_tool_calling"));
  // A credit weight below what the worst turn costs is refused.
  assert.ok(judgeCodingModel(codingProfile(), codingDeps(true, 9)).reasons.includes("credits_below_floor:9"));
  assert.ok(judgeCodingModel(codingProfile(), codingDeps(true, null)).reasons.includes("credit_floor_unbounded"));
});

test("the snapshot hash names content, not key order or row order", () => {
  const a = { modelId: "a", ...codingProfile() };
  const b = { modelId: "b", ...codingProfile({ name: "Other" }) };
  assert.equal(catalogContentHash([a, b]), catalogContentHash([b, a]));
  assert.equal(canonicalJson({ y: 1, x: [2, { b: 1, a: 2 }] }), '{"x":[2,{"a":2,"b":1}],"y":1}');
  assert.notEqual(catalogContentHash([a]), catalogContentHash([a, b]));
  assert.match(catalogContentHash([a]), /^[0-9a-f]{64}$/);
});

test("a snapshot past its coverage is not current", () => {
  const until = snapshotCoverageUntil(NOW);
  assert.equal(snapshotIsCurrent(until, NOW), true);
  assert.equal(snapshotIsCurrent(until, new Date(until.getTime() + 1)), false);
});

test("a quote whose price version moved is reported; an older client is not checked", () => {
  const current = (id) => ({ a: "v2", b: "v1" })[id] ?? null;
  assert.deepEqual(stalePricingVersions({ a: "v1", b: "v1" }, current), ["a"]);
  assert.deepEqual(stalePricingVersions(undefined, current), []);
  assert.deepEqual(stalePricingVersions({ gone: "v1" }, current), ["gone"]);
});

test("an LLM image answer becomes a price revision draft at the policy floor", () => {
  const draft = imageDraftFromAnswer(
    { options: [{ quality: "low", size: "1024x1024", outputCostMicroUsd: 6_000 }], thinkingCapMicroUsd: 0 },
    ["https://developers.openai.com/pricing"],
    "gpt-image-3"
  );
  assert.equal(draft.prices[0].credits >= 1, true);
  assert.equal(draft.verification.sources[0], "https://developers.openai.com/pricing");
  assert.throws(() => imageDraftFromAnswer({ options: [] }, [], "x"));
});

test("an image draft takes the thinking cap the code already knows for the model", () => {
  const answer = {
    options: [{ quality: "high", size: "1024x1024", outputCostMicroUsd: 35_000, outputTokens: null }],
    outputUsdPerMTok: null,
    thinkingCapMicroUsd: null,
    noPriceReason: null,
  };
  const sources = ["https://www.alibabacloud.com/help/en/model-studio/model-pricing"];
  // qwen-image models are billed per image with no thinking charge.
  assert.equal(imageDraftFromAnswer(answer, sources, "qwen-image-2.0", "qwen").verification.thinkingCapMicroUsd, 0);
  // A larger stated cap is kept: the draft never lowers what the pages say.
  assert.equal(
    imageDraftFromAnswer({ ...answer, thinkingCapMicroUsd: 500 }, sources, "qwen-image-2.0", "qwen").verification.thinkingCapMicroUsd,
    500
  );
  // Another model on the same endpoint has no proven bound, nor does an
  // unmeasured Google model; a measured one takes its measured bound.
  assert.equal(imageDraftFromAnswer(answer, sources, "z-image-turbo", "qwen").verification.thinkingCapMicroUsd, null);
  assert.equal(imageDraftFromAnswer(answer, sources, "gemini-3-pro-image", "google").verification.thinkingCapMicroUsd, null);
  const flash = imageDraftFromAnswer(
    { ...answer, options: [{ quality: "medium", size: "1024x1024", outputCostMicroUsd: 67_200, outputTokens: null }] },
    sources,
    "gemini-3.1-flash-image",
    "google"
  );
  assert.equal(flash.verification.thinkingCapMicroUsd, 12_288);
  assert.equal(flash.prices[0].credits, 94);
  assert.equal(imageDraftFromAnswer(answer, sources, "qwen-image-2.0").verification.thinkingCapMicroUsd, null);
});

test("an image answer with only token counts is priced by code, not by the model", () => {
  // OpenAI's table for models before gpt-image-2: high 1024x1024 is 4,160
  // output tokens; at US$30 per million that is 124,800 micro-USD.
  const draft = imageDraftFromAnswer(
    {
      options: [
        { quality: "high", size: "1024x1024", outputCostMicroUsd: null, outputTokens: 4_160 },
        { quality: "low", size: "1024x1024", outputCostMicroUsd: null, outputTokens: null },
      ],
      outputUsdPerMTok: 30,
      thinkingCapMicroUsd: 0,
      noPriceReason: null,
    },
    ["https://developers.openai.com/api/docs/guides/image-generation"],
    "gpt-image-1.5"
  );
  // The option with neither a price nor a token count is dropped, not guessed.
  assert.equal(draft.prices.length, 1);
  assert.equal(draft.prices[0].outputCostMicroUsd, 124_800);
});

test("a per-image cost takes the larger of the stated price and the token arithmetic", () => {
  assert.equal(imageOptionCostMicroUsd(100_000, 4_160, 30), 124_800);
  assert.equal(imageOptionCostMicroUsd(130_000, 4_160, 30), 130_000);
  assert.equal(imageOptionCostMicroUsd(null, 4_160, null), null);
  assert.equal(imageOptionCostMicroUsd(null, null, 30), null);
  assert.equal(imageOptionCostMicroUsd(null, 1_120, 30.5), 34_160);
  assert.equal(imageOptionCostMicroUsd(-5, 0, 30), null);
});

test("an image answer without a usable price says why", () => {
  const answer = {
    options: [{ quality: "high", size: "1024x1024", outputCostMicroUsd: null, outputTokens: null }],
    outputUsdPerMTok: 30,
    thinkingCapMicroUsd: null,
    noPriceReason: "Only per-token rates,\n no tokens per image.",
  };
  assert.throws(
    () => imageDraftFromAnswer(answer, [], "gpt-image-2.5-flare"),
    (error) => error.code === "draft_rejected" && error.detail === "no_options: Only per-token rates, no tokens per image."
  );
  assert.throws(
    () => imageDraftFromAnswer({ ...answer, noPriceReason: null }, [], "x"),
    (error) => error.detail === "no_options"
  );
});

test("an LLM coding answer from the price page alone becomes a draft with no provider conditions", () => {
  // A draft reads the price page only: no terms or retention page is required (owner decision 2026-11-21).
  const sources = ["https://developers.openai.com/pricing"];
  const answer = {
    name: "GPT Coding",
    minimumPlan: "Pro",
    capabilities: codingProfile().capabilities,
    pricing: { inputUsdPerMTok: 1, outputUsdPerMTok: 8 },
  };
  const draft = codingDraftFromAnswer(answer, "openai", "gpt-coding", sources, () => 7);
  assert.equal(draft.pricing.creditWeight, 7);
  assert.deepEqual(draft.pricing.sources, sources);
  assert.equal("terms" in draft, false);
  assert.equal("retention" in draft, false);
  assert.equal("processingRegion" in draft, false);
  assert.deepEqual(judgeCodingModel(draft, codingDeps(true, 7)), { admitted: true });
  // An answer that still carries the old fields is ignored, not trusted.
  const stale = codingDraftFromAnswer(
    { ...answer, terms: { allowsResaleAndCodingAgent: true, url: "https://openai.com/not-fetched" }, retentionUrl: sources[0], processingRegion: "US" },
    "openai",
    "gpt-coding",
    sources,
    () => 7
  );
  assert.equal("terms" in stale, false);
  // The floor still bounds the draft.
  assert.throws(
    () => codingDraftFromAnswer(answer, "openai", "gpt-coding", sources, () => null),
    (error) => error.detail === "credit_floor_unbounded"
  );
});

// Qwen3 Coder Flash (owner decisions 2026-11-22): the pages state a 1M context
// and tool calling, no output limit, and price by input-size tier -- one
// request's input tokens set the rate of its whole input and output.
const QWEN_PRICING = "https://www.alibabacloud.com/help/en/model-studio/model-pricing";
const QWEN_TIERS = [
  { upToInputTokens: 32_000, inputUsdPerMTok: 0.3, outputUsdPerMTok: 1.5 },
  { upToInputTokens: 128_000, inputUsdPerMTok: 0.5, outputUsdPerMTok: 2.5 },
  { upToInputTokens: 256_000, inputUsdPerMTok: 0.8, outputUsdPerMTok: 4 },
  { upToInputTokens: null, inputUsdPerMTok: 1.6, outputUsdPerMTok: 9.6 },
];
const qwenAnswer = (overrides = {}) => ({
  name: "Qwen3 Coder Flash",
  minimumPlan: "Pro",
  capabilities: { toolCalling: "parallel", structuredOutput: "supported", imageInput: false, maxContextTokens: 1_000_000, maxOutputTokens: null },
  pricing: { inputUsdPerMTok: 1.6, outputUsdPerMTok: 9.6, tiers: QWEN_TIERS },
  ...overrides,
});

test("an output limit the pages do not state drafts at the 8,192 default, says so, and is what the floor prices", () => {
  const priced = [];
  const floor = (profile) => {
    priced.push(profile.capabilities.maxOutputTokens);
    return 3;
  };
  const draft = codingDraftFromAnswer(qwenAnswer(), "qwen", "qwen3-coder-flash", [QWEN_PRICING], floor);
  assert.equal(CODING_DEFAULT_MAX_OUTPUT_TOKENS, 8_192);
  assert.equal(draft.capabilities.maxOutputTokens, 8_192);
  assert.equal(draft.basis.maxOutputTokens, "default");
  assert.deepEqual(priced, [8_192], "the credit floor is worked out at the default cap");
  assert.equal(draft.pricing.creditWeight, 3);
  // A zero or malformed answer is "not stated" too: never a refusal, never a larger guess.
  for (const stated of [0, -1, 1.5, "64k", undefined]) {
    const read = codingDraftFromAnswer(
      qwenAnswer({ capabilities: { ...qwenAnswer().capabilities, maxOutputTokens: stated } }),
      "qwen",
      "qwen3-coder-flash",
      [QWEN_PRICING],
      () => 3
    );
    assert.equal(read.capabilities.maxOutputTokens, 8_192, String(stated));
    assert.equal(read.basis.maxOutputTokens, "default", String(stated));
  }
  // A stated limit stands and is marked as the pages'.
  const stated = codingDraftFromAnswer(
    qwenAnswer({ capabilities: { ...qwenAnswer().capabilities, maxOutputTokens: 65_536 } }),
    "qwen",
    "qwen3-coder-flash",
    [QWEN_PRICING],
    () => 3
  );
  assert.equal(stated.capabilities.maxOutputTokens, 65_536);
  assert.equal(stated.basis.maxOutputTokens, "documented");
  // An unknown context window is still refused: the Code floor assumes the whole window as input.
  assert.throws(
    () =>
      codingDraftFromAnswer(
        qwenAnswer({ capabilities: { ...qwenAnswer().capabilities, maxContextTokens: null } }),
        "qwen",
        "qwen3-coder-flash",
        [QWEN_PRICING],
        () => 3
      ),
    (error) => error.code === "draft_rejected" && error.detail === "capabilities.maxContextTokens"
  );
  assert.equal(codingProfileSchema.safeParse(draft).success, true);
});

test("a tiered price drafts at the dearest tier, keeps the tier list, and raises an answer that gave a cheaper tier", () => {
  const draft = codingDraftFromAnswer(qwenAnswer(), "qwen", "qwen3-coder-flash", [QWEN_PRICING], () => 3);
  assert.equal(draft.pricing.inputUsdPerMTok, 1.6);
  assert.equal(draft.pricing.outputUsdPerMTok, 9.6);
  assert.deepEqual(draft.basis.priceTiers, QWEN_TIERS);
  // The model gave the cheapest tier's rates: code takes the dearest listed, never below a tier.
  const cheap = codingDraftFromAnswer(
    qwenAnswer({ pricing: { inputUsdPerMTok: 0.3, outputUsdPerMTok: 1.5, tiers: QWEN_TIERS } }),
    "qwen",
    "qwen3-coder-flash",
    [QWEN_PRICING],
    () => 3
  );
  assert.equal(cheap.pricing.inputUsdPerMTok, 1.6);
  assert.equal(cheap.pricing.outputUsdPerMTok, 9.6);
  // The floor is worked out at those rates.
  const rates = [];
  codingDraftFromAnswer(
    qwenAnswer({ pricing: { inputUsdPerMTok: 0.5, outputUsdPerMTok: 2.5, tiers: QWEN_TIERS } }),
    "qwen",
    "qwen3-coder-flash",
    [QWEN_PRICING],
    (profile) => {
      rates.push([profile.pricing.inputUsdPerMTok, profile.pricing.outputUsdPerMTok]);
      return 3;
    }
  );
  assert.deepEqual(rates, [[1.6, 9.6]]);
  // An answered rate above every tier is not lowered.
  const above = codingDraftFromAnswer(
    qwenAnswer({ pricing: { inputUsdPerMTok: 2, outputUsdPerMTok: 12, tiers: QWEN_TIERS } }),
    "qwen",
    "qwen3-coder-flash",
    [QWEN_PRICING],
    () => 3
  );
  assert.deepEqual([above.pricing.inputUsdPerMTok, above.pricing.outputUsdPerMTok], [2, 12]);
  // One flat price: no tiers in the basis.
  const flat = codingDraftFromAnswer(
    qwenAnswer({ pricing: { inputUsdPerMTok: 1, outputUsdPerMTok: 5, tiers: [] } }),
    "qwen",
    "qwen3-coder-flash",
    [QWEN_PRICING],
    () => 3
  );
  assert.deepEqual([flat.pricing.inputUsdPerMTok, flat.pricing.outputUsdPerMTok], [1, 5]);
  assert.equal("priceTiers" in flat.basis, false);
  // A malformed tier list is refused, not priced from part of it.
  for (const tiers of [[{ upToInputTokens: 32_000, inputUsdPerMTok: -1, outputUsdPerMTok: 1.5 }], [{ inputUsdPerMTok: 1 }], "tiers"]) {
    assert.throws(
      () =>
        codingDraftFromAnswer(
          qwenAnswer({ pricing: { inputUsdPerMTok: 1.6, outputUsdPerMTok: 9.6, tiers } }),
          "qwen",
          "qwen3-coder-flash",
          [QWEN_PRICING],
          () => 3
        ),
      (error) => error.code === "draft_rejected" && error.detail === "pricing.tiers"
    );
  }
});

test("a tier list out of order is refused: upToInputTokens must ascend and only the last tier may be open", () => {
  const tier = (upToInputTokens, inputUsdPerMTok = 1, outputUsdPerMTok = 5) => ({ upToInputTokens, inputUsdPerMTok, outputUsdPerMTok });
  const draft = (tiers) =>
    codingDraftFromAnswer(qwenAnswer({ pricing: { inputUsdPerMTok: 1.6, outputUsdPerMTok: 9.6, tiers } }), "qwen", "qwen3-coder-flash", [QWEN_PRICING], () => 3);
  for (const [label, tiers] of [
    ["descending", [tier(128_000), tier(32_000), tier(null)]],
    ["a repeated bound", [tier(32_000), tier(32_000), tier(null)]],
    ["an open tier first", [tier(null), tier(32_000)]],
    ["an open tier in the middle", [tier(32_000), tier(null), tier(256_000)]],
    ["two open tiers", [tier(32_000), tier(null), tier(null)]],
  ]) {
    assert.throws(() => draft(tiers), (error) => error.code === "draft_rejected" && error.detail === "pricing.tiers", label);
    assert.equal(codingPriceTiersSchema.safeParse(tiers).success, false, label);
  }
  // In order, with or without an open top tier, and one open tier alone: accepted.
  for (const tiers of [QWEN_TIERS, [tier(32_000), tier(128_000)], [tier(null)], [tier(1)]]) {
    assert.equal(codingPriceTiersSchema.safeParse(tiers).success, true);
  }
  // The order is a drafting check only: a stored profile whose list is out of
  // order still reads, so no serving row is dropped by a later, stricter rule.
  const stored = draft(QWEN_TIERS);
  const unordered = { ...stored, basis: { ...stored.basis, priceTiers: [tier(256_000), tier(32_000)] } };
  assert.equal(codingProfileSchema.safeParse(unordered).success, true);
  assert.equal(codingDraftBasisSchema.safeParse(unordered.basis).success, true);
});

test("with tiers, an answered rate that is not a price is refused, never replaced by a tier's", () => {
  for (const [field, value] of [
    ["inputUsdPerMTok", -1],
    ["outputUsdPerMTok", -0.5],
    ["inputUsdPerMTok", "1.6"],
    ["outputUsdPerMTok", null],
    ["inputUsdPerMTok", Number.NaN],
  ]) {
    const pricing = { inputUsdPerMTok: 1.6, outputUsdPerMTok: 9.6, tiers: QWEN_TIERS, [field]: value };
    assert.throws(
      () => codingDraftFromAnswer(qwenAnswer({ pricing }), "qwen", "qwen3-coder-flash", [QWEN_PRICING], () => 3),
      (error) => error.code === "draft_rejected" && error.detail.includes(`pricing.${field}`),
      `${field}: ${String(value)}`
    );
  }
  // A zero rate is a price: raised to the dearest tier as before.
  const zero = codingDraftFromAnswer(qwenAnswer({ pricing: { inputUsdPerMTok: 0, outputUsdPerMTok: 0, tiers: QWEN_TIERS } }), "qwen", "qwen3-coder-flash", [QWEN_PRICING], () => 3);
  assert.deepEqual([zero.pricing.inputUsdPerMTok, zero.pricing.outputUsdPerMTok], [1.6, 9.6]);
});

const olderDedicatedProfile = () => ({
  source: "dedicated",
  name: "Older Coder",
  provider: "deepseek",
  apiModelId: "deepseek-coder-older",
  minimumPlan: "Pro",
  capabilities: { toolCalling: "parallel", structuredOutput: "json_mode", imageInput: false, maxContextTokens: 128_000, maxOutputTokens: 8_192 },
  pricing: { inputUsdPerMTok: 0.3, outputUsdPerMTok: 1.2, creditWeight: 4, verifiedAt: "2026-11-01", sources: ["https://api-docs.deepseek.com/quick_start/pricing"] },
});

test("a write saves an older structured output value as supported and names what it changed; one of the two choices is left alone", () => {
  const dedicated = codingStoredProfileSchema.parse(olderDedicatedProfile());
  const written = codingProfileForWrite(dedicated);
  assert.equal(written.profile.capabilities.structuredOutput, "supported");
  assert.deepEqual(written.rewritten, [{ field: "capabilities.structuredOutput", from: "json_mode", to: "supported" }]);
  // Every other field is as it was.
  assert.deepEqual({ ...written.profile, capabilities: { ...written.profile.capabilities, structuredOutput: "json_mode" } }, dedicated);

  const link = codingStoredProfileSchema.parse({
    source: "chat",
    registryModelId: "claude-sonnet-4-6",
    capabilities: { toolCalling: "parallel", structuredOutput: "forced_tool_use" },
    channels: ["code", "api"],
    evidence: { sources: [], draftedAt: "2026-11-01", toolCalling: "parallel", structuredOutput: "strict_schema" },
  });
  const linkWritten = codingProfileForWrite(link);
  assert.equal(linkWritten.profile.capabilities.structuredOutput, "supported");
  assert.equal(linkWritten.profile.evidence.structuredOutput, "supported");
  assert.deepEqual(linkWritten.rewritten.map((change) => [change.field, change.from]), [
    ["capabilities.structuredOutput", "forced_tool_use"],
    ["evidence.structuredOutput", "strict_schema"],
  ]);
  assert.equal(codingStoredProfileSchema.safeParse(linkWritten.profile).success, true);

  // Already one of the two choices, with or without evidence: nothing rewritten, the same content.
  const withoutEvidence = { ...link };
  delete withoutEvidence.evidence;
  for (const structuredOutput of ["supported", "none"]) {
    for (const current of [
      { ...withoutEvidence, capabilities: { ...link.capabilities, structuredOutput } },
      { ...link, capabilities: { ...link.capabilities, structuredOutput }, evidence: { ...link.evidence, structuredOutput } },
    ]) {
      const same = codingProfileForWrite(current);
      assert.deepEqual(same.rewritten, []);
      assert.equal(canonicalJson(same.profile), canonicalJson(current));
    }
  }
  // Reading is unchanged: the older values still parse as they are stored.
  assert.equal(link.capabilities.structuredOutput, "forced_tool_use");
});

test("the draft answer schemas carry the tiers, a nullable output limit and two structured output choices", () => {
  assert.deepEqual(CODING_STRUCTURED_OUTPUT_CHOICES, ["supported", "none"]);
  const caps = CODING_SCHEMA.properties.capabilities.properties;
  assert.deepEqual(caps.structuredOutput.enum, ["supported", "none"]);
  assert.deepEqual(caps.maxOutputTokens.type, ["integer", "null"]);
  assert.deepEqual(caps.maxContextTokens.type, ["integer", "null"]);
  assert.ok(CODING_SCHEMA.properties.pricing.required.includes("tiers"));
  assert.deepEqual(CODING_SCHEMA.properties.pricing.properties.tiers.items.required, ["upToInputTokens", "inputUsdPerMTok", "outputUsdPerMTok"]);
  assert.match(CODING_TASK, /pricing\.tiers/);
  assert.match(CODING_TASK, /dearest tier/);
  assert.deepEqual(CAPABILITY_SCHEMA.properties.structuredOutput.enum, ["supported", "none"]);
});

test("JSON mode alone is structured output support: the prompts say so, and a JSON-mode-only answer is saved as supported", () => {
  // DeepSeek and GLM state JSON mode (response_format json_object) and no schema (owner decision 2026-11-22).
  for (const task of [CODING_TASK, CAPABILITY_TASK]) {
    assert.match(task, /JSON mode \(for example\s+response_format json_object\)/);
    assert.match(task, /JSON mode alone is\s+"supported"/);
  }
  const deepseekPages = ["https://api-docs.deepseek.com/guides/json_mode/"];
  // The answer as the schema allows it, and as a model that ignores the schema might give it.
  for (const structuredOutput of ["supported", "json_mode"]) {
    const draft = codingCapabilitiesFromAnswer({ toolCalling: "parallel", structuredOutput, note: "JSON mode: response_format json_object." }, deepseekPages);
    assert.equal(draft.structuredOutput, "supported", structuredOutput);
  }
  const dedicated = codingDraftFromAnswer(
    qwenAnswer({ capabilities: { ...qwenAnswer().capabilities, structuredOutput: "json_mode" } }),
    "deepseek",
    "deepseek-coder-x",
    ["https://api-docs.deepseek.com/quick_start/pricing"],
    () => 3
  );
  assert.equal(dedicated.capabilities.structuredOutput, "supported");
});

test("structured output is saved as one of two choices, and every older value still reads as supported", () => {
  for (const legacy of ["json_mode", "strict_schema", "forced_tool_use", "response_schema", "supported"]) {
    assert.equal(codingStructuredOutputChoice(legacy), "supported", legacy);
    const draft = codingDraftFromAnswer(
      qwenAnswer({ capabilities: { ...qwenAnswer().capabilities, structuredOutput: legacy } }),
      "qwen",
      "qwen3-coder-flash",
      [QWEN_PRICING],
      () => 3
    );
    assert.equal(draft.capabilities.structuredOutput, "supported", legacy);
    assert.equal(codingCapabilitiesFromAnswer({ toolCalling: "basic", structuredOutput: legacy }, []).structuredOutput, "supported", legacy);
  }
  for (const unknown of ["none", "made_up", null, 3]) {
    assert.equal(codingStructuredOutputChoice(unknown), "none", String(unknown));
  }
  // Every stored value still parses: the read list keeps the older ones.
  for (const value of CODING_STRUCTURED_OUTPUT) {
    assert.equal(codingProfileSchema.safeParse({ ...codingProfile(), capabilities: { ...codingProfile().capabilities, structuredOutput: value } }).success, true, value);
  }
});

test("a reserved image request runs only with the profile it was priced with", () => {
  const model = { provider: "google", apiModelId: "img-a", maxOutputTokens: 1000, thinkingLevel: "low" };
  const snapshot = JSON.parse(JSON.stringify({ outputCostMicroUsd: 1, executionProfile: imageExecutionProfile(model) }));
  assert.equal(imageExecutionDrift(snapshot, model), null);
  assert.equal(imageExecutionDrift(snapshot, { ...model, apiModelId: "img-b" }), "apiModelId_changed");
  assert.equal(imageExecutionDrift(snapshot, { ...model, thinkingLevel: "high" }), "thinkingLevel_changed");
  assert.equal(imageExecutionDrift(snapshot, { ...model, maxOutputTokens: undefined }), "maxOutputTokens_changed");
  assert.equal(imageExecutionDrift(snapshot, null), "model_missing");
  // A reservation from before the field existed has nothing to compare.
  assert.equal(imageExecutionDrift({ outputCostMicroUsd: 1 }, null), null);
});

test("the scheduled renewal extends identical content inside the last week and nothing else", () => {
  const day = 24 * 60 * 60 * 1000;
  const same = "a".repeat(64);
  const snapshot = (daysLeft, contentHash = same) => ({
    contentHash,
    coverageUntil: new Date(NOW.getTime() + daysLeft * day),
  });
  assert.equal(SNAPSHOT_RENEWAL_WINDOW_MS, 7 * day);
  // The first snapshot is a person's to publish.
  assert.equal(decideSnapshotRenewal(null, same, NOW), "no_snapshot");
  // Plenty of coverage left: nothing to do.
  assert.equal(decideSnapshotRenewal(snapshot(29), same, NOW), "not_due");
  assert.equal(decideSnapshotRenewal(snapshot(7.5), same, NOW), "not_due");
  // Exactly a week left is already due (the manual publish uses the same edge).
  assert.equal(decideSnapshotRenewal(snapshot(7), same, NOW), "renew");
  assert.equal(decideSnapshotRenewal(snapshot(1), same, NOW), "renew");
  // Past coverage with content still judged the same is renewed too.
  assert.equal(decideSnapshotRenewal(snapshot(-3), same, NOW), "renew");
  // Changed content is never renewed by the job, due or not, expired or not.
  const other = "b".repeat(64);
  assert.equal(decideSnapshotRenewal(snapshot(29), other, NOW), "content_changed");
  assert.equal(decideSnapshotRenewal(snapshot(2), other, NOW), "content_changed");
  assert.equal(decideSnapshotRenewal(snapshot(-3), other, NOW), "content_changed");
  // A snapshot written before a row gained defaulted fields: its stored hash
  // differs, its rows read through today's schema match, so it is renewed.
  const legacy = (daysLeft) => ({ ...snapshot(daysLeft, other), normalizedHash: same });
  assert.equal(decideSnapshotRenewal(legacy(2), same, NOW), "renew");
  assert.equal(decideSnapshotRenewal(legacy(-3), same, NOW), "renew");
  assert.equal(decideSnapshotRenewal(legacy(29), same, NOW), "not_due");
  // Normalised content that still differs is not renewed.
  assert.equal(decideSnapshotRenewal({ ...snapshot(2, other), normalizedHash: "c".repeat(64) }, same, NOW), "content_changed");
  assert.equal(decideSnapshotRenewal({ ...snapshot(2, other), normalizedHash: null }, same, NOW), "content_changed");
});

test("page text drops scripts and tags", () => {
  assert.equal(pageToText("<p>a</p><script>x()</script><style>.b{}</style> b"), "a b");
});

test("page text omits script and style bodies with browser-accepted end tags", async (t) => {
  for (const [name, ending] of [
    ["space", " "],
    ["tab", "\t"],
    ["newline", "\n"],
    ["carriage return", "\r"],
    ["form feed", "\f"],
    ["attribute", ' data-note="ignored"'],
    ["slash", "/"],
  ]) {
    await t.test(name, () => {
      const body = `<p>before</p><ScRiPt type="text/javascript">script noise</sCrIpT${ending}><STYLE media="all">style noise</sTyLe${ending}><p>after</p>`;
      assert.equal(pageToText(body), "before after");
    });
  }
});

test("page text preserves bodies of tags that only start with script or style", () => {
  for (const tag of ["scripture", "script-custom", "script_data", "script:note", "styleguide", "style-custom"]) {
    assert.equal(pageToText(`<${tag}>keep this</${tag}><script>omit this</script>`), "keep this", tag);
  }
});

test("page text keeps ordinary whitespace normalization and the input budget", () => {
  assert.equal(pageToText("<p> one&nbsp; \n two </p>"), "one two");
  assert.equal(pageToText("a".repeat(120_001)).length, 120_000);
});

test("a draft's pricing version fits the revision schema for any API model id", () => {
  const pattern = /^[A-Za-z0-9._:-]{1,80}$/;
  for (const id of ["gpt-image-2", "fal-ai/flux-pro/v1.1-ultra", "x".repeat(200), "///"]) {
    const version = draftPricingVersion(id, "2026-10-19");
    assert.match(version, pattern, id);
    assert.ok(version.endsWith("-2026-10-19-llm"));
  }
});

test("an image draft review gives each option's floor and the judge's answer at the draft prices", () => {
  const draft = {
    prices: enabledSeed.prices.map((price) => ({ ...price })),
    verification: { ...enabledSeed.priceVerification, verifiedAt: "2026-11-12" },
  };
  const review = reviewImageDraft(enabledSeed, draft, { minimumCredits: minimumCreditsForImageOption });
  assert.equal(review.floors.length, draft.prices.length);
  for (const [index, floor] of review.floors.entries()) {
    assert.equal(floor.quality, draft.prices[index].quality);
    assert.equal(floor.floor, minimumCreditsForImageOption(enabledSeed, draft.prices[index]));
  }
  assert.deepEqual(review.reasons, []);

  // One option a credit under its floor is named by quality and size.
  const low = draft.prices[0];
  const floor = minimumCreditsForImageOption(enabledSeed, low);
  const under = reviewImageDraft(
    enabledSeed,
    { ...draft, prices: [{ ...low, credits: floor - 1 }, ...draft.prices.slice(1)] },
    { minimumCredits: minimumCreditsForImageOption }
  );
  assert.deepEqual(under.reasons, [`credits_below_floor:${low.quality}/${low.size}`]);

  // No reasoning cap: no floor can be computed and the judge refuses.
  const uncapped = reviewImageDraft(
    enabledSeed,
    { ...draft, verification: { ...draft.verification, thinkingCapMicroUsd: null } },
    { minimumCredits: minimumCreditsForImageOption }
  );
  if (enabledSeed.priceVerification.thinkingCapMicroUsd !== null) {
    assert.ok(uncapped.floors.every((entry) => entry.floor === null));
    assert.ok(uncapped.reasons.includes("worst_case_cost_unbounded"));
  }
});

test("credit overrides change only credits, only for options the draft priced", () => {
  const prices = [
    { quality: "low", size: "1024x1024", credits: 24, outputCostMicroUsd: 20_000 },
    { quality: "medium", size: "1024x1024", credits: 41, outputCostMicroUsd: 35_000 },
  ];
  const applied = applyImageCreditOverrides(prices, [
    { quality: "medium", size: "1024x1024", credits: 45 },
    { quality: "low", size: "1024x1024", credits: 24 },
  ]);
  assert.equal(applied.ok, true);
  assert.deepEqual(applied.prices, [prices[0], { ...prices[1], credits: 45 }]);
  assert.deepEqual(applied.edits, [{ quality: "medium", size: "1024x1024", from: 41, to: 45 }]);
  // The draft's own objects are not changed.
  assert.equal(prices[1].credits, 41);

  const unknown = applyImageCreditOverrides(prices, [{ quality: "high", size: "1536x1024", credits: 90 }]);
  assert.deepEqual(unknown, { ok: false, unknown: ["high|1536x1024"] });
  assert.equal(imageCreditOverrideSchema.safeParse([{ quality: "low", size: "1024x1024", credits: 0 }]).success, false);
  assert.equal(imageCreditOverrideSchema.safeParse([{ quality: "low", size: "1024x1024", credits: 3, outputCostMicroUsd: 1 }]).success, false);
});

test("a draft applied again the same day gets the next free version name within 80 characters", () => {
  assert.equal(freePricingVersion("qwen-image-2.0-2026-11-12-llm", new Set()), "qwen-image-2.0-2026-11-12-llm");
  assert.equal(freePricingVersion("v-llm", new Set(["v-llm"])), "v-llm-2");
  assert.equal(freePricingVersion("v-llm", new Set(["v-llm", "v-llm-2"])), "v-llm-3");
  const long = "x".repeat(80);
  const next = freePricingVersion(long, new Set([long]));
  assert.equal(next.length, 80);
  assert.ok(next.endsWith("-2"));
});

test("coding notes: the answer is read to the limits, never cut, and the router text keeps every item whole", () => {
  // Owner decision 2026-11-22: two or three each, one line of at most 120 characters, standing on the fetched pages.
  const pages = ["https://developers.openai.com/api/docs/guides/function-calling"];
  const long = "x".repeat(121);
  const draft = codingCapabilitiesFromAnswer(
    {
      toolCalling: "parallel",
      structuredOutput: "supported",
      note: "",
      codingNotes: {
        strengths: ["  Parallel   tool calls ", long, "Strict schemas", "Long context", "Fourth"],
        weaknesses: ["No vision in tools", 7],
        sourceUrls: [pages[0], pages[0], 3],
      },
    },
    pages
  );
  // The over-long item is left out, not cut; at most three; whitespace folded; URLs as given, once.
  assert.deepEqual(draft.codingNotes, {
    strengths: ["Parallel tool calls", "Strict schemas", "Long context"],
    weaknesses: ["No vision in tools"],
    sourceUrls: [pages[0]],
  });
  for (const codingNotes of [undefined, null, { strengths: [], weaknesses: [], sourceUrls: pages }, { strengths: [long] }]) {
    assert.equal(codingCapabilitiesFromAnswer({ toolCalling: "basic", structuredOutput: "none", codingNotes }, pages).codingNotes, null);
  }
  // The answer schema asks for the notes in the same call.
  assert.ok(CAPABILITY_SCHEMA.required.includes("codingNotes"));
  assert.deepEqual(CAPABILITY_SCHEMA.properties.codingNotes.required, ["strengths", "weaknesses", "sourceUrls"]);
  assert.equal(CAPABILITY_SCHEMA.properties.codingNotes.properties.strengths.maxItems, 3);
  assert.match(CAPABILITY_TASK, /benchmark result/);
  assert.match(CAPABILITY_TASK, /never a claim\s+from general knowledge/);
  assert.match(CAPABILITY_TASK, /at most 120/);
  // The notes stand first on the models page, and a guide that shows another model is not an absence for this one.
  assert.match(CAPABILITY_TASK, /first on the models page/);
  assert.match(CAPABILITY_TASK, /not its absence for this model/);

  // The stored shape holds the same limits.
  const ok = { strengths: ["a".repeat(120)], weaknesses: [], sources: pages, draftedAt: "2026-11-22" };
  assert.equal(codingNotesSchema.safeParse(ok).success, true);
  assert.equal(codingNotesSchema.safeParse({ ...ok, strengths: [long] }).success, false);
  assert.equal(codingNotesSchema.safeParse({ ...ok, strengths: ["a", "b", "c", "d"] }).success, false);
  assert.equal(codingNotesSchema.safeParse({ ...ok, strengths: ["two\nlines"] }).success, false);
  assert.equal(codingNotesSchema.safeParse({ ...ok, sources: ["not a url"] }).success, false);

  const full = { strengths: ["s".repeat(120), "t".repeat(120), "u".repeat(120)], weaknesses: ["w".repeat(120), "v".repeat(120), "z".repeat(120)] };
  const text = codingNotesRouterText(full);
  for (const item of [...full.strengths, ...full.weaknesses]) assert.ok(text.includes(item), "every item whole");
  assert.equal(codingNotesRouterText({ strengths: ["Parallel tool calls"], weaknesses: [] }), "Coding strengths: Parallel tool calls.");
  assert.equal(
    codingNotesRouterText({ strengths: ["A", "B"], weaknesses: ["C"] }),
    "Coding strengths: A; B. Coding weaknesses: C."
  );
});

test("the benchmark search is off until a model is named, asks for the provider's own pages, and keeps only those", async () => {
  assert.equal(await benchmarkPageSearchFromEnv({}), null);
  assert.equal(await benchmarkPageSearchFromEnv({ MODEL_CATALOG_BENCHMARK_SEARCH_MODEL_ID: "  " }), null);
  const prompt = benchmarkSearchPrompt({ provider: "anthropic", apiModelId: "claude-x", name: "Claude X" });
  assert.ok(prompt.includes('"Claude X" (API model id claude-x)'));
  assert.ok(prompt.includes("www.anthropic.com"));
  assert.ok(prompt.includes("platform.claude.com/docs/"));
  assert.equal(BENCHMARK_SEARCH_SCHEMA.properties.urls.maxItems, 3);
  assert.deepEqual(
    benchmarkUrlsFromAnswer(
      {
        urls: [
          "https://www.anthropic.com/news/claude-x",
          "https://www.anthropic.com/news/claude-x",
          "http://www.anthropic.com/news/claude-x-card",
          "https://community.anthropic.com/claude-x",
          "https://platform.claude.com/login",
          42,
          "https://docs.claude.com/en/models/claude-x",
          "https://www.anthropic.com/claude-x-system-card",
        ],
      },
      "anthropic"
    ),
    ["https://www.anthropic.com/news/claude-x", "https://docs.claude.com/en/models/claude-x", "https://www.anthropic.com/claude-x-system-card"]
  );
  for (const answer of [null, undefined, {}, { urls: "https://www.anthropic.com/news/claude-x" }]) {
    assert.deepEqual(benchmarkUrlsFromAnswer(answer, "anthropic"), []);
  }
  assert.deepEqual(benchmarkUrlsFromAnswer({ urls: ["https://www.anthropic.com/news/claude-x"] }, "openrouter"), []);
  assert.match(CAPABILITY_TASK, /benchmark or announcement page/);
});

test("the benchmark search through the SDK: a cut-off or unanswered call is an unknown outcome, a provider error is not", async () => {
  const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
  const input = { provider: "anthropic", apiModelId: "claude-x", name: "Claude X", timeoutMs: 1_000 };
  const answering = (text) =>
    new MockLanguageModelV4({ doGenerate: { content: [{ type: "text", text }], usage, finishReason: { unified: "stop", raw: undefined }, response: { body: {} }, warnings: [] } });
  const official = "https://www.anthropic.com/news/claude-x";
  assert.deepEqual(
    await benchmarkPageSearchWith(answering(JSON.stringify({ urls: [official, "https://blog.example.com/x"] })), "search-1").findPages(input),
    [official]
  );

  // Cut off by its deadline, whatever error the SDK wraps the abort in.
  const hanging = new MockLanguageModelV4({
    doGenerate: ({ abortSignal }) =>
      new Promise((_resolve, reject) =>
        abortSignal.addEventListener("abort", () =>
          reject(new APICallError({ message: "aborted", url: "https://example.invalid", requestBodyValues: {}, isRetryable: true, cause: abortSignal.reason }))
        )
      ),
  });
  await assert.rejects(benchmarkPageSearchWith(hanging, "search-1").findPages({ ...input, timeoutMs: 20 }), (error) => error instanceof BenchmarkSearchOutcomeUnknown && error.name === "TimeoutError");

  // A dropped connection: the provider never answered.
  const dropped = new MockLanguageModelV4({ doGenerate: async () => { throw new Error("socket hang up"); } });
  await assert.rejects(benchmarkPageSearchWith(dropped, "search-1").findPages(input), (error) => error instanceof BenchmarkSearchOutcomeUnknown);

  // The provider answered with an error, or with an answer that does not parse: a known failure, not a timeout.
  const refused = new MockLanguageModelV4({
    doGenerate: async () => {
      throw new APICallError({ message: "bad request", url: "https://example.invalid", requestBodyValues: {}, statusCode: 400, isRetryable: false, responseBody: "{}" });
    },
  });
  await assert.rejects(benchmarkPageSearchWith(refused, "search-1").findPages(input), (error) => APICallError.isInstance(error) && error.name !== "TimeoutError");
  await assert.rejects(benchmarkPageSearchWith(answering("not json"), "search-1").findPages(input), (error) => !(error instanceof BenchmarkSearchOutcomeUnknown));
});
