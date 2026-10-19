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
  effectiveRevisions,
  isOfficialSourceUrl,
  judgeCodingModel,
  judgeImageModel,
  judgeVideoModel,
  MODEL_CATALOG_CATEGORIES,
  resolveImageCatalog,
  snapshotCoverageUntil,
  snapshotIsCurrent,
  stalePricingVersions,
} from "../lib/modelCatalogCore.ts";
import { codingDraftFromAnswer, imageDraftFromAnswer, pageToText } from "../lib/modelCatalogDraftLlm.ts";

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
  assert.equal(model.disabledNote, "provider incident");
  assert.equal(model.name, "Renamed");
  assert.deepEqual(model.prices, enabledSeed.prices);
  assert.equal(model.pricingVersion, enabledSeed.pricingVersion);
});

test("turning on a model whose worst case is unbounded is refused by the judge, not by the row", () => {
  const { models } = resolve([row(heldSeed.id, { enabled: true })]);
  assert.equal(models.find((m) => m.id === heldSeed.id).disabledReason, "worst_case_cost_unbounded");
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
  terms: { allowsResaleAndCodingAgent: true, url: "https://openai.com/policies/services-agreement", checkedAt: "2026-10-19" },
  retention: { url: "https://platform.openai.com/docs/guides/your-data", checkedAt: "2026-10-19" },
  processingRegion: "US",
  ...overrides,
});

const codingDeps = (established = true) => ({
  knownProvider: (p) => p === "openai",
  providerDestinationEstablished: () => established,
});

test("a coding model needs terms, retention and an established data destination", () => {
  assert.deepEqual(judgeCodingModel(codingProfile(), codingDeps()), { admitted: true });
  const noTerms = judgeCodingModel(
    codingProfile({ terms: { allowsResaleAndCodingAgent: false, url: "https://openai.com/terms", checkedAt: "2026-10-19" } }),
    codingDeps()
  );
  assert.ok(noTerms.reasons.includes("terms_do_not_allow"));
  assert.ok(judgeCodingModel(codingProfile(), codingDeps(false)).reasons.includes("provider_destination_unproven"));
  const blog = judgeCodingModel(
    codingProfile({ retention: { url: "https://someblog.example/openai", checkedAt: "2026-10-19" } }),
    codingDeps()
  );
  assert.ok(blog.reasons.includes("retention_source_unofficial"));
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

test("an LLM coding answer cannot cite a page it did not fetch", () => {
  const sources = ["https://developers.openai.com/pricing"];
  const draft = codingDraftFromAnswer(
    {
      name: "GPT Coding",
      minimumPlan: "Pro",
      capabilities: codingProfile().capabilities,
      pricing: { inputUsdPerMTok: 1, outputUsdPerMTok: 8 },
      terms: { allowsResaleAndCodingAgent: true, url: "https://openai.com/not-fetched" },
      retentionUrl: "https://openai.com/also-not-fetched",
      processingRegion: "US",
    },
    "openai",
    "gpt-coding",
    sources
  );
  assert.equal(draft.terms.allowsResaleAndCodingAgent, false);
  assert.equal(draft.terms.url, sources[0]);
  assert.equal(draft.retention.url, sources[0]);
  assert.ok(draft.pricing.creditWeight >= 1);
});

test("page text drops scripts and tags", () => {
  assert.equal(pageToText("<p>a</p><script>x()</script><style>.b{}</style> b"), "a b");
});
