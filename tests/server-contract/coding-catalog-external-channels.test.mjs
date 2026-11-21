import assert from "node:assert/strict";
import { resolve } from "node:path";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";

// The two external APIs' model lists (owner decision 2026-11-21). The general
// API (/api/v1, /api/anthropic) is always the chat registry and never reads the
// coding catalogue. The coding API (/api/code/v1, /api/code/anthropic) is the
// general API's list while CODING_CATALOG_EXTERNAL_CHANNELS_ENABLED is off; on,
// a row must be in the newest valid snapshot for the coding API and still be
// admitted by the coding judge now. A chat link runs as its chat model, a
// dedicated row as its own row with the snapshot's pricing.

const root = resolve(import.meta.dirname, "../..");
const mod = (path) => pathToFileURL(resolve(root, path)).href;

const reads = { snapshot: 0, entries: 0, terms: 0 };
let snapshot = null;
let entries = [];
let providerTerms = [];

mock.module(mod("lib/activeAiModel.ts"), { namedExports: { getActiveAiModel: () => null } });
mock.module(mod("lib/prisma.ts"), {
  namedExports: {
    prisma: {
      modelCatalogSnapshot: {
        findFirst: async () => {
          reads.snapshot += 1;
          return snapshot;
        },
      },
      modelCatalogEntry: {
        findMany: async () => {
          reads.entries += 1;
          return entries;
        },
      },
      codingProviderTerms: {
        findMany: async () => {
          reads.terms += 1;
          return providerTerms;
        },
      },
    },
  },
});

// Registry price overrides keep the coding floor small and the price verified.
const runtimeModel = (id, extra = {}) => ({
  id,
  name: id,
  apiModel: id,
  provider: "openai",
  icon: "",
  bestFor: "",
  minimumPlan: "Free",
  usageClass: "standard",
  enabled: true,
  status: "enabled",
  contextWindowTokens: 100_000,
  maxOutputTokens: 8_000,
  inputUsdPerMillionTokens: 0.1,
  outputUsdPerMillionTokens: 0.4,
  ...extra,
});

mock.module(mod("lib/modelRegistry.ts"), {
  namedExports: {
    getRuntimeModels: async () => [runtimeModel("gpt-6-luna"), runtimeModel("gpt-5-6-terra", { usageClass: "advanced" })],
  },
});

process.env.OPENAI_API_KEY = "test-openai-key-not-real";

const { externalApiRunnableModels, externalApiOfferedModels } = await import(mod("lib/externalApiCatalog.ts"));
const { loadCodingCatalog, servableCodingRows } = await import(mod("lib/modelCatalog.ts"));

const TERMS = "https://openai.com/policies/services-agreement";
const RETENTION = "https://platform.openai.com/docs/guides/your-data";
const today = new Date().toISOString().slice(0, 10);
const termsRow = (overrides = {}) => ({
  provider: "openai",
  terms: { allowsResaleAndCodingAgent: true, termsUrl: TERMS, retentionUrl: RETENTION, processingRegion: "US", checkedAt: today, sources: [TERMS], ...overrides },
  draft: null,
  draftCreatedAt: null,
  updatedByEmail: null,
  updatedAt: new Date(),
});
const entry = (modelId, channels, extra = {}) => ({
  modelId,
  enabled: true,
  holdReason: null,
  draft: null,
  draftCreatedAt: null,
  profile: {
    source: "chat",
    registryModelId: modelId,
    capabilities: { toolCalling: "parallel", structuredOutput: "strict_schema" },
    creditWeight: 50,
    channels,
    ...extra,
  },
});
/** A model chat does not have: its whole profile is the row's. */
const dedicatedEntry = (modelId, channels, extra = {}) => ({
  modelId,
  enabled: true,
  holdReason: null,
  draft: null,
  draftCreatedAt: null,
  profile: {
    source: "dedicated",
    name: "Coder X",
    provider: "openai",
    apiModelId: "coder-x-2026-11",
    minimumPlan: "Pro",
    capabilities: { toolCalling: "parallel", structuredOutput: "strict_schema", imageInput: false, maxContextTokens: 64_000, maxOutputTokens: 4_000 },
    pricing: { inputUsdPerMTok: 0.2, outputUsdPerMTok: 0.8, creditWeight: 7, verifiedAt: today, sources: ["https://openai.com/api/pricing/"] },
    terms: { allowsResaleAndCodingAgent: true, url: TERMS, checkedAt: today },
    retention: { url: RETENTION, checkedAt: today },
    processingRegion: "US",
    channels,
    ...extra,
  },
});

/** The snapshot as publishing would write it: the rows the judges admit now. */
const publish = async (version = 7) => {
  const models = servableCodingRows(await loadCodingCatalog());
  snapshot = { version, contentHash: "c".repeat(64), category: "coding", coverageUntil: new Date(Date.now() + 86_400_000), payload: { models } };
  return models;
};

const setSwitch = (value) => {
  if (value === undefined) delete process.env.CODING_CATALOG_EXTERNAL_CHANNELS_ENABLED;
  else process.env.CODING_CATALOG_EXTERNAL_CHANNELS_ENABLED = value;
};

const ids = async (plan, surface) => (await externalApiRunnableModels(plan, { surface })).map((item) => item.model.id);
const resetReads = () => Object.assign(reads, { snapshot: 0, entries: 0, terms: 0 });

test("switched off, the coding API offers what the general API offers and the coding catalogue is not read", async () => {
  setSwitch(undefined);
  resetReads();
  assert.deepEqual(await ids("Pro", "general"), ["gpt-6-luna", "gpt-5-6-terra"]);
  assert.deepEqual(await ids("Pro", "coding"), ["gpt-6-luna", "gpt-5-6-terra"]);
  for (const surface of ["general", "coding"]) {
    assert.deepEqual((await externalApiOfferedModels("Pro", { surface })).map((model) => model.id), ["smart-adaptive", "gpt-6-luna", "gpt-5-6-terra"]);
  }
  assert.ok((await externalApiRunnableModels("Pro", { surface: "coding" })).every((item) => item.catalogPricing === undefined));
  assert.deepEqual(reads, { snapshot: 0, entries: 0, terms: 0 });
  setSwitch("false");
  assert.equal((await ids("Pro", "coding")).length, 2);
  assert.deepEqual(reads, { snapshot: 0, entries: 0, terms: 0 });
});

test("switched on, the general API still offers the chat registry and reads nothing of the coding catalogue", async () => {
  setSwitch("true");
  providerTerms = [termsRow()];
  entries = [entry("gpt-6-luna", ["code"]), dedicatedEntry("coder-x", ["code", "api"])];
  await publish(6);
  resetReads();
  assert.deepEqual(await ids("Pro", "general"), ["gpt-6-luna", "gpt-5-6-terra"]);
  assert.deepEqual((await externalApiOfferedModels("Pro", { surface: "general" })).map((model) => model.id), ["smart-adaptive", "gpt-6-luna", "gpt-5-6-terra"]);
  assert.deepEqual(reads, { snapshot: 0, entries: 0, terms: 0 });
  setSwitch(undefined);
});

test("switched on, the coding API offers the published rows of both sources that list it and the plan reaches", async () => {
  setSwitch("true");
  providerTerms = [termsRow()];
  entries = [
    entry("gpt-6-luna", ["code", "api"]),
    entry("gpt-5-6-terra", ["code", "api"], { minimumPlan: "Max" }),
    dedicatedEntry("coder-x", ["code", "api"]),
  ];
  const published = await publish();
  assert.deepEqual(published.map((row) => row.modelId).sort(), ["coder-x", "gpt-5-6-terra", "gpt-6-luna"]);
  assert.deepEqual(await ids("Pro", "coding"), ["gpt-6-luna", "coder-x"]);
  assert.deepEqual(await ids("Max", "coding"), ["gpt-6-luna", "gpt-5-6-terra", "coder-x"]);
  // The dedicated row runs as its own row, priced from the snapshot.
  const coder = (await externalApiRunnableModels("Pro", { surface: "coding" })).find((item) => item.model.id === "coder-x");
  assert.equal(coder.model.apiModel, "coder-x-2026-11");
  assert.equal(coder.capabilities.creditWeight, 7);
  assert.equal(coder.capabilities.maxOutputTokens, 4_000);
  assert.equal(coder.model.inputUsdPerMillionTokens, 0.2);
  assert.equal(coder.model.outputUsdPerMillionTokens, 0.8);
  assert.deepEqual(coder.catalogPricing, {
    cacheWriteUsdPerMillionTokens: null,
    pricingVersion: `coding_catalog_snapshot:7:${"c".repeat(64)}`,
    costSource: "coding_catalog_snapshot",
  });
  // A chat link runs and bills as its chat model.
  const luna = (await externalApiRunnableModels("Pro", { surface: "coding" })).find((item) => item.model.id === "gpt-6-luna");
  assert.equal(luna.catalogPricing, undefined);
  // Smart Adaptive is drawn from the same list.
  assert.deepEqual((await externalApiOfferedModels("Pro", { surface: "coding" })).map((model) => model.id), ["smart-adaptive", "gpt-6-luna", "coder-x"]);
  setSwitch(undefined);
});

test("a row saved with the CLI's own channel is on the coding API", async () => {
  setSwitch("true");
  providerTerms = [termsRow()];
  entries = [entry("gpt-6-luna", ["code", "cli"]), dedicatedEntry("coder-x", ["cli"])];
  await publish(10);
  assert.deepEqual(await ids("Pro", "coding"), ["gpt-6-luna", "coder-x"]);
  setSwitch(undefined);
});

test("a hold, an untick or a provider re-check that refuses a model takes it off at once, before any new publish", async () => {
  setSwitch("true");
  providerTerms = [termsRow()];
  entries = [entry("gpt-6-luna", ["code", "api"])];
  await publish(8);
  assert.deepEqual(await ids("Pro", "coding"), ["gpt-6-luna"]);
  entries = [{ ...entry("gpt-6-luna", ["code", "api"]), holdReason: "check" }];
  assert.deepEqual(await ids("Pro", "coding"), []);
  // A minimum plan raised since publishing applies at once.
  entries = [entry("gpt-6-luna", ["code", "api"], { minimumPlan: "Max" })];
  assert.deepEqual(await ids("Pro", "coding"), []);
  assert.deepEqual(await ids("Max", "coding"), ["gpt-6-luna"]);
  entries = [entry("gpt-6-luna", ["code"])];
  assert.deepEqual(await ids("Pro", "coding"), []);
  entries = [entry("gpt-6-luna", ["code", "api"])];
  providerTerms = [termsRow({ allowsResaleAndCodingAgent: false })];
  assert.deepEqual(await ids("Pro", "coding"), []);
  // An unpublished channel is not offered either: publishing is what exposes it.
  providerTerms = [termsRow()];
  entries = [entry("gpt-6-luna", ["code"])];
  await publish(9);
  entries = [entry("gpt-6-luna", ["code", "api"])];
  assert.deepEqual(await ids("Pro", "coding"), []);
  setSwitch(undefined);
});

test("a dedicated row whose current row differs from the published one, or whose provider cannot be bounded, is not offered", async () => {
  setSwitch("true");
  providerTerms = [termsRow()];
  entries = [dedicatedEntry("coder-x", ["code", "api"])];
  await publish(11);
  assert.deepEqual(await ids("Pro", "coding"), ["coder-x"]);
  // A credit weight raised since publishing: charged at the published row only after the next publish.
  entries = [dedicatedEntry("coder-x", ["code", "api"], { pricing: { inputUsdPerMTok: 0.2, outputUsdPerMTok: 0.8, creditWeight: 8, verifiedAt: today, sources: ["https://openai.com/api/pricing/"] } })];
  assert.deepEqual(await ids("Pro", "coding"), []);
  // An inference host is refused by the judge for the coding API, so it is never published there.
  entries = [dedicatedEntry("coder-x", ["code", "api"], { provider: "openrouter" })];
  assert.equal((await publish(12)).length, 0);
  assert.deepEqual(await ids("Max", "coding"), []);
  setSwitch(undefined);
});

test("switched on with no snapshot, or one past its coverage, the coding API offers nothing", async () => {
  setSwitch("true");
  providerTerms = [termsRow()];
  entries = [entry("gpt-6-luna", ["code", "api"])];
  snapshot = null;
  assert.deepEqual(await ids("Pro", "coding"), []);
  assert.deepEqual(await externalApiOfferedModels("Pro", { surface: "coding" }), []);
  // The general API is unaffected.
  assert.deepEqual(await ids("Pro", "general"), ["gpt-6-luna", "gpt-5-6-terra"]);
  await publish(9);
  snapshot = { ...snapshot, coverageUntil: new Date(Date.now() - 1_000) };
  assert.deepEqual(await ids("Pro", "coding"), []);
  setSwitch(undefined);
});
