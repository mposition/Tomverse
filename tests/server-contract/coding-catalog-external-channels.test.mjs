import assert from "node:assert/strict";
import { resolve } from "node:path";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";

// The external API's model list with CODING_CATALOG_EXTERNAL_CHANNELS_ENABLED
// off (the default) and on (owner decision 2026-11-20). Off, nothing of the
// coding catalogue is read and the list is the chat registry's as before. On,
// a model must be in the newest valid snapshot for the channel and still be
// admitted by the coding judge now.

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

/** The snapshot as publishing would write it: the rows the judges admit now. */
const publish = async (version = 7) => {
  const models = servableCodingRows(await loadCodingCatalog());
  snapshot = { version, category: "coding", coverageUntil: new Date(Date.now() + 86_400_000), payload: { models } };
  return models;
};

const setSwitch = (value) => {
  if (value === undefined) delete process.env.CODING_CATALOG_EXTERNAL_CHANNELS_ENABLED;
  else process.env.CODING_CATALOG_EXTERNAL_CHANNELS_ENABLED = value;
};

const ids = async (plan, channel) => (await externalApiRunnableModels(plan, channel ? { channel } : {})).map((item) => item.model.id);

test("switched off, the external list is the chat registry's and the coding catalogue is not read", async () => {
  setSwitch(undefined);
  reads.snapshot = 0;
  reads.entries = 0;
  reads.terms = 0;
  assert.deepEqual(await ids("Pro"), ["gpt-6-luna", "gpt-5-6-terra"]);
  assert.deepEqual(await ids("Pro", "cli"), ["gpt-6-luna", "gpt-5-6-terra"]);
  assert.deepEqual((await externalApiOfferedModels("Pro")).map((model) => model.id), ["smart-adaptive", "gpt-6-luna", "gpt-5-6-terra"]);
  assert.deepEqual(reads, { snapshot: 0, entries: 0, terms: 0 });
  setSwitch("false");
  assert.equal((await ids("Pro")).length, 2);
  assert.deepEqual(reads, { snapshot: 0, entries: 0, terms: 0 });
});

test("switched on, each channel offers only the published chat links that list it and the plan reaches", async () => {
  setSwitch("true");
  providerTerms = [termsRow()];
  entries = [entry("gpt-6-luna", ["code", "api"]), entry("gpt-5-6-terra", ["code", "cli"], { minimumPlan: "Max" })];
  const published = await publish();
  assert.deepEqual(published.map((row) => row.modelId).sort(), ["gpt-5-6-terra", "gpt-6-luna"]);
  assert.deepEqual(await ids("Pro"), ["gpt-6-luna"]);
  // The CLI's link asks for Max: a Pro account does not get it, a Max one does.
  assert.deepEqual(await ids("Pro", "cli"), []);
  assert.deepEqual(await ids("Max", "cli"), ["gpt-5-6-terra"]);
  // Smart Adaptive is drawn from the same list.
  assert.deepEqual((await externalApiOfferedModels("Pro")).map((model) => model.id), ["smart-adaptive", "gpt-6-luna"]);
});

test("a hold, an untick or a provider re-check that refuses a model takes it off at once, before any new publish", async () => {
  setSwitch("true");
  providerTerms = [termsRow()];
  entries = [entry("gpt-6-luna", ["code", "api"])];
  await publish(8);
  assert.deepEqual(await ids("Pro"), ["gpt-6-luna"]);
  entries = [{ ...entry("gpt-6-luna", ["code", "api"]), holdReason: "check" }];
  assert.deepEqual(await ids("Pro"), []);
  // A minimum plan raised since publishing applies at once.
  entries = [entry("gpt-6-luna", ["code", "api"], { minimumPlan: "Max" })];
  assert.deepEqual(await ids("Pro"), []);
  assert.deepEqual(await ids("Max"), ["gpt-6-luna"]);
  entries = [entry("gpt-6-luna", ["code"])];
  assert.deepEqual(await ids("Pro"), []);
  entries = [entry("gpt-6-luna", ["code", "api"])];
  providerTerms = [termsRow({ allowsResaleAndCodingAgent: false })];
  assert.deepEqual(await ids("Pro"), []);
  // An unpublished channel is not offered either: publishing is what exposes it.
  providerTerms = [termsRow()];
  entries = [entry("gpt-6-luna", ["code", "api", "cli"])];
  assert.deepEqual(await ids("Pro", "cli"), []);
});

test("switched on with no snapshot, or one past its coverage, nothing is offered", async () => {
  setSwitch("true");
  providerTerms = [termsRow()];
  entries = [entry("gpt-6-luna", ["code", "api"])];
  snapshot = null;
  assert.deepEqual(await ids("Pro"), []);
  assert.deepEqual(await externalApiOfferedModels("Pro"), []);
  await publish(9);
  snapshot = { ...snapshot, coverageUntil: new Date(Date.now() - 1_000) };
  assert.deepEqual(await ids("Pro"), []);
  setSwitch(undefined);
});
