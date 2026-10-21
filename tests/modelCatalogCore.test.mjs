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
  judgeCodingModel,
  judgeImageModel,
  judgeVideoModel,
  MODEL_CATALOG_CATEGORIES,
  resolveImageCatalog,
  snapshotCoverageUntil,
  snapshotIsCurrent,
  SNAPSHOT_RENEWAL_WINDOW_MS,
  stalePricingVersions,
} from "../lib/modelCatalogCore.ts";
import { codingDraftFromAnswer, draftPricingVersion, imageDraftFromAnswer, pageToText } from "../lib/modelCatalogDraftLlm.ts";

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

const codingDeps = (established = true, floor = 1) => ({
  knownProvider: (p) => p === "openai",
  providerDestinationEstablished: () => established,
  creditFloor: () => floor,
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

test("an LLM coding answer cannot cite a page it did not fetch", () => {
  const sources = ["https://developers.openai.com/pricing", "https://platform.openai.com/docs/guides/your-data"];
  const answer = {
    name: "GPT Coding",
    minimumPlan: "Pro",
    capabilities: codingProfile().capabilities,
    pricing: { inputUsdPerMTok: 1, outputUsdPerMTok: 8 },
    terms: { allowsResaleAndCodingAgent: true, url: "https://openai.com/not-fetched" },
    retentionUrl: sources[1],
    processingRegion: "US",
  };
  const draft = codingDraftFromAnswer(answer, "openai", "gpt-coding", sources, () => 7);
  assert.equal(draft.terms.allowsResaleAndCodingAgent, false);
  assert.equal(draft.terms.url, sources[0]);
  assert.equal(draft.retention.url, sources[1]);
  assert.equal(draft.pricing.creditWeight, 7);

  // No fetched retention page: refused, not filled in with the price page
  // (review finding 2026-10-19).
  for (const retentionUrl of ["https://openai.com/also-not-fetched", undefined]) {
    assert.throws(
      () => codingDraftFromAnswer({ ...answer, retentionUrl }, "openai", "gpt-coding", sources, () => 7),
      (error) => error.detail === "retention_source_missing"
    );
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
});

test("page text drops scripts and tags", () => {
  assert.equal(pageToText("<p>a</p><script>x()</script><style>.b{}</style> b"), "a b");
});

test("a draft's pricing version fits the revision schema for any API model id", () => {
  const pattern = /^[A-Za-z0-9._:-]{1,80}$/;
  for (const id of ["gpt-image-2", "fal-ai/flux-pro/v1.1-ultra", "x".repeat(200), "///"]) {
    const version = draftPricingVersion(id, "2026-10-19");
    assert.match(version, pattern, id);
    assert.ok(version.endsWith("-2026-10-19-llm"));
  }
});
