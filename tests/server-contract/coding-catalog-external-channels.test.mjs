import assert from "node:assert/strict";
import { resolve } from "node:path";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";

// The external API's model list with CODING_CATALOG_EXTERNAL_CHANNELS_ENABLED
// off (the default) and on (owner decision 2026-11-20). Off, nothing of the
// coding catalogue is read and the list is the chat registry's as before.

const root = resolve(import.meta.dirname, "../..");
const mod = (path) => pathToFileURL(resolve(root, path)).href;

const reads = { snapshot: 0, entries: 0 };
let snapshot = null;
let activeIds = [];

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
          return activeIds.map((modelId) => ({ modelId }));
        },
      },
    },
  },
});

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
  contextWindowTokens: 400_000,
  ...extra,
});

mock.module(mod("lib/modelRegistry.ts"), {
  namedExports: {
    getRuntimeModels: async () => [runtimeModel("gpt-6-luna"), runtimeModel("gpt-5-6-terra", { usageClass: "advanced" })],
  },
});

process.env.OPENAI_API_KEY = "test-openai-key-not-real";

const { externalApiRunnableModels, externalApiOfferedModels } = await import(mod("lib/externalApiCatalog.ts"));

const row = (modelId, channels, minimumPlan = "Pro") => ({
  modelId,
  source: "chat",
  registryModelId: modelId,
  channels,
  name: modelId,
  provider: "openai",
  apiModelId: modelId,
  minimumPlan,
  capabilities: { toolCalling: "parallel", structuredOutput: "strict_schema", imageInput: true, maxContextTokens: 400_000, maxOutputTokens: 32_000 },
  pricing: { inputUsdPerMTok: 1, outputUsdPerMTok: 4, creditWeight: 2, verifiedAt: "2026-10-12", sources: [], pricingVersion: "v1" },
  terms: { allowsResaleAndCodingAgent: true, url: "https://openai.com/policies/services-agreement", checkedAt: "2026-11-01" },
  retention: { url: "https://platform.openai.com/docs/your-data", checkedAt: "2026-11-01" },
  processingRegion: "US",
});

const setSwitch = (value) => {
  if (value === undefined) delete process.env.CODING_CATALOG_EXTERNAL_CHANNELS_ENABLED;
  else process.env.CODING_CATALOG_EXTERNAL_CHANNELS_ENABLED = value;
};

test("switched off, the external list is the chat registry's and the coding catalogue is not read", async () => {
  setSwitch(undefined);
  reads.snapshot = 0;
  reads.entries = 0;
  const ids = (await externalApiRunnableModels("Pro")).map((entry) => entry.model.id);
  assert.deepEqual(ids, ["gpt-6-luna", "gpt-5-6-terra"]);
  const cli = (await externalApiRunnableModels("Pro", { channel: "cli" })).map((entry) => entry.model.id);
  assert.deepEqual(cli, ids);
  const offered = (await externalApiOfferedModels("Pro")).map((model) => model.id);
  assert.deepEqual(offered, ["smart-adaptive", "gpt-6-luna", "gpt-5-6-terra"]);
  assert.deepEqual(reads, { snapshot: 0, entries: 0 });
  setSwitch("false");
  assert.equal((await externalApiRunnableModels("Pro")).length, 2);
  assert.deepEqual(reads, { snapshot: 0, entries: 0 });
});

test("switched on, each channel offers only the chat links the newest snapshot lists for it", async () => {
  setSwitch("true");
  snapshot = {
    version: 7,
    category: "coding",
    coverageUntil: new Date(Date.now() + 86_400_000),
    payload: { models: [row("gpt-6-luna", ["code", "api"]), row("gpt-5-6-terra", ["code", "cli"], "Max")] },
  };
  activeIds = ["gpt-6-luna", "gpt-5-6-terra"];
  assert.deepEqual((await externalApiRunnableModels("Pro")).map((entry) => entry.model.id), ["gpt-6-luna"]);
  // The CLI's link asks for Max: a Pro account does not get it, a Max one does.
  assert.deepEqual((await externalApiRunnableModels("Pro", { channel: "cli" })).map((entry) => entry.model.id), []);
  assert.deepEqual((await externalApiRunnableModels("Max", { channel: "cli" })).map((entry) => entry.model.id), ["gpt-5-6-terra"]);
  // Smart Adaptive is drawn from the same list.
  assert.deepEqual((await externalApiOfferedModels("Pro")).map((model) => model.id), ["smart-adaptive", "gpt-6-luna"]);
  // A link held or turned off since the snapshot leaves at once.
  activeIds = ["gpt-5-6-terra"];
  assert.deepEqual((await externalApiRunnableModels("Pro")).map((entry) => entry.model.id), []);
});

test("switched on with no snapshot, or one past its coverage, nothing is offered", async () => {
  setSwitch("true");
  activeIds = ["gpt-6-luna"];
  snapshot = null;
  assert.deepEqual(await externalApiRunnableModels("Pro"), []);
  assert.deepEqual(await externalApiOfferedModels("Pro"), []);
  snapshot = {
    version: 8,
    category: "coding",
    coverageUntil: new Date(Date.now() - 1_000),
    payload: { models: [row("gpt-6-luna", ["code", "api"])] },
  };
  assert.deepEqual(await externalApiRunnableModels("Pro"), []);
  setSwitch(undefined);
});
