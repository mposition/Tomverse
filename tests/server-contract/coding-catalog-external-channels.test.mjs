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
// Smart Adaptive's router is a paid call: here it answers what a test says and records each call.
const routerCalls = [];
let routerPick = null;
mock.module(mod("lib/autoLlmRouter.ts"), {
  namedExports: {
    pickAutoModelWithLlm: async (input) => {
      routerCalls.push(input);
      return routerPick ? { modelId: routerPick, rewrite: null } : null;
    },
  },
});
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

const baseRuntime = () => [runtimeModel("gpt-6-luna"), runtimeModel("gpt-5-6-terra", { usageClass: "advanced" })];
let runtime = baseRuntime();
mock.module(mod("lib/modelRegistry.ts"), {
  namedExports: {
    getRuntimeModels: async () => runtime,
  },
});

process.env.OPENAI_API_KEY = "test-openai-key-not-real";

const { externalApiRunnableModels, externalApiOfferedModels } = await import(mod("lib/externalApiCatalog.ts"));
const { loadCodingCatalog, servableCodingRows } = await import(mod("lib/modelCatalog.ts"));
const { codingApiCreditFloor } = await import(mod("lib/codingRowRuntime.ts"));
const { toOpenAiModelEntry } = await import(mod("lib/externalApiCatalogCore.ts"));

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
  // Credits by the chat rule at the chat input limit, not Code's weight of 7.
  const floor = codingApiCreditFloor({ provider: "openai", pricing: { inputUsdPerMTok: 0.2, outputUsdPerMTok: 0.8 } }, 4_000);
  assert.ok(floor !== null && floor !== 7);
  assert.equal(coder.capabilities.creditWeight, floor);
  assert.equal(coder.capabilities.maxOutputTokens, 4_000);
  assert.equal(coder.model.inputUsdPerMillionTokens, 0.2);
  assert.equal(coder.model.outputUsdPerMillionTokens, 0.8);
  assert.deepEqual(coder.catalogPricing, {
    cacheWriteUsdPerMillionTokens: null,
    pricingVersion: `coding_catalog_snapshot:7:${"c".repeat(64)}`,
    costSource: "coding_catalog_snapshot",
    creditBasis: { basis: "chat_rule_floor", credits: floor, floorCredits: floor },
  });
  // What /api/code/v1/models lists for it (app/api/code/v1/models -> toOpenAiModelEntry).
  const listed = (await externalApiOfferedModels("Pro", { surface: "coding" })).find((model) => model.id === "coder-x");
  assert.equal(toOpenAiModelEntry(listed).tomverse.credits_per_request, floor);
  // A chat link runs and bills as its chat model.
  const luna = (await externalApiRunnableModels("Pro", { surface: "coding" })).find((item) => item.model.id === "gpt-6-luna");
  assert.equal(luna.catalogPricing, undefined);
  // Smart Adaptive is drawn from the same list.
  assert.deepEqual((await externalApiOfferedModels("Pro", { surface: "coding" })).map((model) => model.id), ["smart-adaptive", "gpt-6-luna", "coder-x"]);
  setSwitch(undefined);
});

test("an apiCreditWeight above the chat rule's floor is what the coding API lists and charges, after a publish", async () => {
  setSwitch("true");
  providerTerms = [termsRow()];
  const floor = codingApiCreditFloor({ provider: "openai", pricing: { inputUsdPerMTok: 0.2, outputUsdPerMTok: 0.8 } }, 4_000);
  entries = [dedicatedEntry("coder-x", ["code", "api"], { apiCreditWeight: floor + 5 })];
  await publish(13);
  const [coder] = await externalApiRunnableModels("Pro", { surface: "coding" });
  assert.equal(coder.capabilities.creditWeight, floor + 5);
  assert.deepEqual(coder.catalogPricing.creditBasis, { basis: "api_override", credits: floor + 5, floorCredits: floor });
  const listed = (await externalApiOfferedModels("Pro", { surface: "coding" })).find((model) => model.id === "coder-x");
  assert.equal(toOpenAiModelEntry(listed).tomverse.credits_per_request, floor + 5);
  // Changed since publishing: not offered until the next publish.
  entries = [dedicatedEntry("coder-x", ["code", "api"], { apiCreditWeight: floor + 6 })];
  assert.deepEqual(await ids("Pro", "coding"), []);
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

test("a hold or an untick takes a model off at once, before any new publish; provider terms never do", async () => {
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
  // A provider record that denies resale no longer refuses a model (owner decision 2026-11-21).
  providerTerms = [termsRow({ allowsResaleAndCodingAgent: false })];
  assert.deepEqual(await ids("Pro", "coding"), ["gpt-6-luna"]);
  // And a provider with no record at all is offered the same.
  providerTerms = [];
  assert.deepEqual(await ids("Pro", "coding"), ["gpt-6-luna"]);
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

// Frontier and apex on the coding catalogue (owner decision 2026-11-22): coding
// candidates, listed by /models, nameable on the coding API at their own chat
// credits, offered only with credits the registry holds; the general API keeps
// the rule that only Smart Adaptive routes to them.
test("frontier and apex links are listed and nameable on the coding API at their chat credits, and still router-only on the general API", async () => {
  const { codingCandidateExclusion } = await import(mod("lib/modelCatalogCore.ts"));
  const { chatModelFacts } = await import(mod("lib/modelCatalog.ts"));
  setSwitch("true");
  providerTerms = [];
  runtime = [
    ...baseRuntime(),
    runtimeModel("gpt-6-2-astra", { usageClass: "frontier", minimumPlan: "Pro", creditWeight: 32 }),
    runtimeModel("gpt-6-2-apex", { usageClass: "apex", minimumPlan: "Pro", creditWeight: 80 }),
    // The registry holds no credits for this one: never offered on the coding API.
    runtimeModel("gpt-6-2-unpriced", { usageClass: "frontier", minimumPlan: "Pro", creditWeight: 0 }),
  ];
  try {
    for (const id of ["gpt-6-2-astra", "gpt-6-2-apex"]) {
      assert.equal(codingCandidateExclusion(chatModelFacts(runtime.find((model) => model.id === id)), new Set()), null, id);
    }
    // No registry credits: the facts say so, and the candidate list and the judge
    // refuse it on the condition the coding API serves it on (hasRegistryCredits).
    const unpricedFacts = chatModelFacts(runtime.find((model) => model.id === "gpt-6-2-unpriced"));
    assert.equal(unpricedFacts.registryCredits, false);
    assert.equal(unpricedFacts.creditWeight, 32, "chat's class default, which nobody set");
    assert.equal(codingCandidateExclusion(unpricedFacts, new Set()), "chat_credits_missing");
    assert.equal(chatModelFacts(runtime.find((model) => model.id === "gpt-6-2-astra")).registryCredits, true);
    entries = [
      entry("gpt-6-luna", ["api"]),
      entry("gpt-6-2-astra", ["api"]),
      entry("gpt-6-2-apex", ["api"]),
      entry("gpt-6-2-unpriced", ["api"]),
    ];
    const published = await publish(21);
    assert.ok(published.some((row) => row.modelId === "gpt-6-2-astra"), "a frontier link is admitted on the coding API");
    // The link to the unpriced one is refused by the judge, so it is never published.
    assert.ok(!published.some((row) => row.modelId === "gpt-6-2-unpriced"));
    const refusedLink = (await loadCodingCatalog()).find((entry) => entry.modelId === "gpt-6-2-unpriced");
    assert.equal(refusedLink.admission.admitted, false);
    assert.ok(refusedLink.channelAdmission.api.reasons.includes("chat_credits_missing"));

    // Named directly on the coding API (the list a named request is validated against).
    const named = await externalApiRunnableModels("Pro", { surface: "coding" });
    assert.deepEqual(named.map((item) => item.model.id), ["gpt-6-luna", "gpt-6-2-astra", "gpt-6-2-apex"]);
    assert.ok(named.every((item) => item.nameable === true));
    const astra = named.find((item) => item.model.id === "gpt-6-2-astra");
    assert.equal(astra.capabilities.creditWeight, 32, "its own chat credits");
    assert.equal(astra.catalogPricing, undefined, "a chat link runs and bills as its chat model");
    assert.equal(named.find((item) => item.model.id === "gpt-6-2-apex").capabilities.creditWeight, 80);
    // /api/code/v1/models lists them, at those credits.
    const offered = await externalApiOfferedModels("Pro", { surface: "coding" });
    assert.deepEqual(offered.map((model) => model.id), ["smart-adaptive", "gpt-6-luna", "gpt-6-2-astra", "gpt-6-2-apex"]);
    assert.equal(toOpenAiModelEntry(offered.find((model) => model.id === "gpt-6-2-astra")).tomverse.credits_per_request, 32);
    // Smart Adaptive routes over them too, and the unpriced one is not offered there either.
    const routed = await externalApiRunnableModels("Pro", { surface: "coding", smartAdaptive: true });
    assert.deepEqual(routed.map((item) => item.model.id), ["gpt-6-luna", "gpt-6-2-astra", "gpt-6-2-apex"]);
    // The plan still applies.
    assert.deepEqual((await externalApiRunnableModels("Free", { surface: "coding" })).map((item) => item.model.id), ["gpt-6-luna"]);

    // The general API: never named, only routed to by Smart Adaptive (owner decision 2026-11-20).
    assert.deepEqual(await ids("Pro", "general"), ["gpt-6-luna", "gpt-5-6-terra"]);
    assert.deepEqual((await externalApiOfferedModels("Pro", { surface: "general" })).map((model) => model.id), ["smart-adaptive", "gpt-6-luna", "gpt-5-6-terra"]);
    const generalRouted = await externalApiRunnableModels("Pro", { surface: "general", smartAdaptive: true });
    assert.ok(generalRouted.some((item) => item.model.id === "gpt-6-2-astra" && item.nameable === false));
    // The coding API with its switch off serves the general API's models, by the general rule.
    setSwitch(undefined);
    assert.deepEqual(await ids("Pro", "coding"), ["gpt-6-luna", "gpt-5-6-terra"]);
  } finally {
    runtime = baseRuntime();
    setSwitch(undefined);
  }
});

test("on the coding catalogue a frontier model is offered without a nameable model of its provider beside it", async () => {
  setSwitch("true");
  providerTerms = [];
  process.env.ANTHROPIC_API_KEY = "test-anthropic-key-not-real";
  runtime = [
    ...baseRuntime(),
    runtimeModel("claude-opus-fixture", { provider: "anthropic", usageClass: "frontier", minimumPlan: "Pro", creditWeight: 40 }),
  ];
  try {
    entries = [entry("gpt-6-luna", ["api"]), entry("claude-opus-fixture", ["api"])];
    await publish(22);
    // Named directly there, it is the only Anthropic model on the coding API.
    assert.deepEqual(await ids("Pro", "coding"), ["gpt-6-luna", "claude-opus-fixture"]);
    // On the general API, alone for its provider, it is not even a Smart Adaptive candidate.
    assert.ok(!(await externalApiRunnableModels("Pro", { surface: "general", smartAdaptive: true })).some((item) => item.model.id === "claude-opus-fixture"));
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
    runtime = baseRuntime();
    setSwitch(undefined);
  }
});

// Smart Adaptive never defaults to frontier or apex, on either API
// (docs/policy/external-api.md 5.1). Nameable on the coding catalogue, they
// can be the only models of a provider or of the whole list there: Smart
// Adaptive is then not offered on that protocol or list, and a request for it
// is refused before any router call, reservation or dispatch.
const smartRouting = async () => {
  const { routeSmartAdaptive } = await import(mod("lib/externalApiSmartAdaptive.ts"));
  const { routeNativeSmartAdaptive } = await import(mod("lib/externalApiNativeSmartAdaptive.ts"));
  const gateAsked = { count: 0 };
  const gate = (allowed) => async () => {
    gateAsked.count += 1;
    return allowed;
  };
  const chatCompletions = (runnable, { keyId = "key-chat", allowed = false, content = "Refactor the parser and add tests" } = {}) =>
    routeSmartAdaptive({
      request: { model: "smart-adaptive", messages: [{ role: "user", content }] },
      runnable,
      keyId,
      userId: "user-smart",
      requestId: `req-${keyId}`,
      routerAllowed: gate(allowed),
      idempotencyKeyDigest: null,
      requestDigest: `digest-${keyId}`,
      userAgent: "contract-test",
    });
  const bodies = {
    anthropic_messages: { model: "smart-adaptive", max_tokens: 1_000, messages: [{ role: "user", content: [{ type: "text", text: "Fix src/sum.ts" }] }] },
    responses: { model: "smart-adaptive", max_output_tokens: 1_000, input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Add tests" }] }] },
  };
  const native = (protocol, runnable, keyId = `key-${protocol}`) =>
    routeNativeSmartAdaptive({
      protocol,
      request: new Request("http://localhost/native", { method: "POST" }),
      body: bodies[protocol],
      runnable,
      keyId,
      userId: "user-smart",
      requestId: `req-${keyId}`,
      routerAllowed: gate(false),
      prepare: ({ maxOutputTokens }) => ({ payload: bodies[protocol], outputLimit: Math.min(1_000, maxOutputTokens) }),
    });
  return { chatCompletions, native, gateAsked };
};

test("on the coding catalogue Smart Adaptive is offered only on a protocol with a model it may default to, and never defaults to frontier or apex", async () => {
  const { codingToolModels } = await import(mod("lib/externalApiCodingTools.ts"));
  setSwitch("true");
  providerTerms = [];
  process.env.ANTHROPIC_API_KEY = "test-anthropic-key-not-real";
  runtime = [
    ...baseRuntime(),
    runtimeModel("claude-opus-fixture", { provider: "anthropic", usageClass: "frontier", minimumPlan: "Pro", creditWeight: 40 }),
    runtimeModel("gpt-6-2-astra", { usageClass: "frontier", minimumPlan: "Pro", creditWeight: 32 }),
  ];
  try {
    entries = [entry("gpt-6-luna", ["api"]), entry("claude-opus-fixture", ["api"]), entry("gpt-6-2-astra", ["api"])];
    await publish(23);
    const offered = await externalApiOfferedModels("Pro", { surface: "coding" });
    const smart = offered.find((model) => model.id === "smart-adaptive");
    assert.ok(smart, "offered beside GPT 6 Luna");
    // Anthropic has only a frontier model here: no Smart Adaptive on Anthropic Messages.
    assert.deepEqual(smart.protocols, ["chat_completions", "responses"]);
    assert.deepEqual(Object.keys(smart.creditWeightByProtocol).sort(), ["chat_completions", "responses"]);
    assert.equal(smart.creditWeight, 40, "the most a request can cost, the router's frontier picks included");
    assert.equal(smart.creditWeightByProtocol.responses, 32);
    assert.equal(offered.find((model) => model.id === "claude-opus-fixture").routerPickOnly, true);
    assert.equal(offered.find((model) => model.id === "gpt-6-luna").routerPickOnly, undefined);
    // The settings page: Claude Code lists the frontier model by name and no Smart Adaptive.
    const tools = codingToolModels(offered);
    assert.deepEqual(tools.claudeCode.map((model) => model.id), ["claude-opus-fixture"]);
    assert.equal(tools.codex[0].id, "smart-adaptive");
    assert.equal(
      tools.codex[0].maxOutputTokens,
      offered.find((model) => model.id === "gpt-6-luna").maxOutputTokens,
      "the default's output limit, not the frontier model's"
    );

    const runnable = await externalApiRunnableModels("Pro", { surface: "coding", smartAdaptive: true });
    const { chatCompletions, native, gateAsked } = await smartRouting();
    // Chat Completions with no router answer: GPT 6 Luna, never a frontier model.
    const plain = await chatCompletions(runnable, { keyId: "key-default" });
    assert.equal(plain.entry.model.id, "gpt-6-luna");
    assert.equal(plain.routedBy, "default");
    // The router may still pick a frontier model; it is charged that model's own credits.
    routerPick = "claude-opus-fixture";
    const picked = await chatCompletions(runnable, { keyId: "key-router", allowed: true });
    assert.equal(picked.entry.model.id, "claude-opus-fixture");
    assert.equal(picked.routedBy, "router");
    assert.equal(picked.entry.capabilities.creditWeight, 40);
    routerPick = null;
    // Responses (Codex) defaults to GPT 6 Luna; Anthropic Messages has nothing to default to and is not offered.
    const codex = await native("responses", runnable);
    assert.equal(codex.entry.model.id, "gpt-6-luna");
    assert.equal(codex.routedBy, "default");
    const asked = gateAsked.count;
    const calls = routerCalls.length;
    assert.equal(await native("anthropic_messages", runnable), null);
    assert.equal(gateAsked.count, asked, "no router gate asked");
    assert.equal(routerCalls.length, calls, "no router call");
    // Naming the frontier model directly still runs on the coding catalogue.
    assert.ok((await externalApiRunnableModels("Pro", { surface: "coding" })).some((item) => item.model.id === "claude-opus-fixture"));
  } finally {
    routerPick = null;
    delete process.env.ANTHROPIC_API_KEY;
    runtime = baseRuntime();
    setSwitch(undefined);
  }
});

test("a coding catalogue of frontier and apex models only lists no Smart Adaptive and refuses it before any router call; naming one still runs", async () => {
  setSwitch("true");
  providerTerms = [];
  process.env.ANTHROPIC_API_KEY = "test-anthropic-key-not-real";
  runtime = [
    ...baseRuntime(),
    runtimeModel("claude-opus-fixture", { provider: "anthropic", usageClass: "frontier", minimumPlan: "Pro", creditWeight: 40 }),
    runtimeModel("gpt-6-2-apex", { usageClass: "apex", minimumPlan: "Pro", creditWeight: 80 }),
  ];
  try {
    entries = [entry("claude-opus-fixture", ["api"]), entry("gpt-6-2-apex", ["api"])];
    await publish(24);
    const offered = await externalApiOfferedModels("Pro", { surface: "coding" });
    assert.deepEqual(offered.map((model) => model.id).sort(), ["claude-opus-fixture", "gpt-6-2-apex"], "no smart-adaptive");
    const runnable = await externalApiRunnableModels("Pro", { surface: "coding", smartAdaptive: true });
    assert.equal(runnable.length, 2);
    const { chatCompletions, native, gateAsked } = await smartRouting();
    const calls = routerCalls.length;
    routerPick = "gpt-6-2-apex";
    // Refused (null: the caller answers 404 model_not_found) with no gate asked and no router call.
    assert.equal(await chatCompletions(runnable, { keyId: "key-only-frontier", allowed: true }), null);
    assert.equal(await native("anthropic_messages", runnable), null);
    assert.equal(await native("responses", runnable), null);
    assert.equal(gateAsked.count, 0);
    assert.equal(routerCalls.length, calls);
    // A client naming one of them is served from the list a named request is validated against.
    assert.deepEqual(
      (await externalApiRunnableModels("Pro", { surface: "coding" })).map((item) => item.model.id).sort(),
      ["claude-opus-fixture", "gpt-6-2-apex"]
    );
  } finally {
    routerPick = null;
    delete process.env.ANTHROPIC_API_KEY;
    runtime = baseRuntime();
    setSwitch(undefined);
  }
});
