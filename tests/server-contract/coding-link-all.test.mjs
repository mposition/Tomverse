import assert from "node:assert/strict";
import { resolve } from "node:path";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";

// Adding chat models to the coding catalogue (owner decision 2026-11-21): one
// at a time and all at once, both from the chat registry with no LLM call. The
// all-at-once run links every candidate on the coding API and on Code too only
// when it passes Code's rules (the judge's per-channel answers are faked here;
// tests/codingCatalogLinks.test.mjs holds the rules). It commits one
// transaction per model -- the link, its audit row and the activation -- so a
// refused or failed model leaves nothing behind and never stops the rest.

const root = resolve(import.meta.dirname, "../..");
const mod = (path) => pathToFileURL(resolve(root, path)).href;

class CatalogRefusal extends Error {
  constructor(code, reasons = [], status = 409) {
    super(code);
    this.code = code;
    this.reasons = reasons;
    this.status = status;
  }
}

// What the fake database holds, and what a transaction may roll back.
const state = { rows: new Map(), audits: [], preexisting: [], facts: [], updates: [], probes: [], locks: 0 };
const clone = () => ({ rows: new Map(state.rows), audits: [...state.audits] });

const tx = {
  modelCatalogEntry: {
    findUnique: async ({ where }) => {
      const id = where.category_modelId.modelId;
      return state.rows.has(id) || state.preexisting.includes(id) ? { modelId: id } : null;
    },
    create: async ({ data }) => {
      state.rows.set(data.modelId, data);
      return data;
    },
  },
};

mock.module(mod("lib/prisma.ts"), {
  namedExports: {
    prisma: {
      modelCatalogEntry: { findMany: async () => state.preexisting.map((modelId) => ({ modelId })) },
      $transaction: async (body) => {
        const before = clone();
        try {
          return await body(tx);
        } catch (error) {
          state.rows = before.rows;
          state.audits = before.audits;
          throw error;
        }
      },
    },
  },
});
mock.module(mod("lib/adminAudit.ts"), {
  namedExports: {
    takeAuditChainLock: async () => {
      state.locks += 1;
    },
    writeAdminAuditLog: async (entry) => {
      assert.equal(entry.tx, tx, "the audit row is written in the caller's transaction");
      state.audits.push(entry);
    },
  },
});
const ok = { admitted: true };
mock.module(mod("lib/modelCatalog.ts"), {
  namedExports: {
    loadChatModelFacts: async () => state.facts,
    loadCodingProviderTerms: async () => [],
    codingLookups: () => ({}),
    // The per-channel answer for the link as it would be made, by model id.
    resolveCodingRow: (row) => {
      state.probes.push({ id: row.modelId, profile: row.profile });
      if (row.modelId.startsWith("refused-both")) {
        const no = { admitted: false, reasons: ["provider_destination_unproven"] };
        return { problem: null, channelAdmission: { api: no, code: no } };
      }
      if (row.modelId.startsWith("api-only")) {
        return { problem: null, channelAdmission: { api: ok, code: { admitted: false, reasons: ["credits_below_floor:7", "no_structured_output"] } } };
      }
      return { problem: null, channelAdmission: { api: ok, code: ok } };
    },
  },
});
mock.module(mod("lib/modelCatalogAdmin.ts"), {
  namedExports: {
    CatalogRefusal,
    updateCatalogEntry: async (input) => {
      assert.equal(input.tx, tx, "the activation runs in the same transaction as the link");
      state.updates.push(input);
      const id = input.modelId;
      if (id === "judge-refused") throw new CatalogRefusal("not_admitted", ["credits_below_floor:7", "unknown_provider"]);
      if (id === "judge-refused-too") throw new CatalogRefusal("not_admitted", ["credits_below_floor:9"]);
      if (id === "db-down") throw new Error("connection reset");
      state.rows.set(id, { ...state.rows.get(id), enabled: input.patch.enabled });
    },
  },
});

const { linkAllChatModels, linkChatModel } = await import(mod("lib/codingCatalogAdmin.ts"));

const session = { user: { id: "admin-1", email: "owner@example.com" } };
const chat = (id, overrides = {}) => ({
  id,
  name: id,
  provider: "openai",
  apiModelId: id,
  minimumPlan: "Pro",
  usageClass: "standard",
  creditWeight: 2,
  enabled: true,
  status: "enabled",
  publiclyListed: true,
  catalogDeleted: false,
  contextWindowTokens: 100_000,
  maxOutputTokens: 8_000,
  imageInput: false,
  price: { inputUsdPerMTok: 1, outputUsdPerMTok: 4, pricingVersion: "v1", effectiveDate: "2026-11-01", verified: true, reasoningBilledSeparately: false },
  ...overrides,
});

const reset = (facts, preexisting = []) => {
  state.rows = new Map();
  state.audits = [];
  state.updates = [];
  state.probes = [];
  state.locks = 0;
  state.preexisting = preexisting;
  state.facts = facts;
};

test("a link takes its two capability values from the registry, with no page and no LLM, and is saved off on Code", async () => {
  reset([chat("gpt-a")]);
  await linkChatModel({ registryModelId: "gpt-a", session });
  const row = state.rows.get("gpt-a");
  assert.equal(row.enabled, null);
  assert.equal(row.profile.source, "chat");
  assert.deepEqual(row.profile.channels, ["code"]);
  assert.deepEqual(row.profile.capabilities, { toolCalling: "basic", structuredOutput: "none" });
  // The evidence records that no page was read.
  assert.deepEqual(row.profile.evidence.sources, []);
  assert.equal(state.audits.length, 1);
  assert.equal(state.audits[0].action, "model_catalog.coding_linked");
  assert.equal(state.audits[0].metadata.source, "chat_registry");
  assert.equal(state.audits[0].metadata.batch, false);
  // A second link of the same model is refused.
  await assert.rejects(linkChatModel({ registryModelId: "gpt-a", session }), (error) => error instanceof CatalogRefusal && error.code === "already_in_catalog");
  // A model the registry does not have, or that is not a candidate, is refused.
  await assert.rejects(linkChatModel({ registryModelId: "nope", session }), (error) => error.code === "chat_model_missing");
  state.facts = [chat("gpt-off", { enabled: false })];
  await assert.rejects(linkChatModel({ registryModelId: "gpt-off", session }), (error) => error.code === "not_a_candidate" && error.reasons[0] === "disabled");
});

test("add-all links every candidate on the coding API, on Code too only where Code's rules pass, and counts refusals without stopping", async () => {
  reset(
    [
      chat("gpt-a"),
      chat("judge-refused"),
      chat("api-only-1"),
      chat("db-down"),
      chat("refused-both"),
      chat("api-only-2"),
      chat("gpt-d"),
      // Not candidates: off, unlisted, an unserved class, and one already in the catalogue.
      chat("gpt-off", { enabled: false }),
      chat("gpt-hidden", { publiclyListed: false }),
      chat("gpt-research", { usageClass: "research" }),
      chat("gpt-have"),
    ],
    ["gpt-have"]
  );
  const result = await linkAllChatModels({ session });
  assert.equal(result.attempted, 7);
  // Every model that passes the coding API is added, the ones around the failures too.
  assert.deepEqual(result.added, ["gpt-a", "api-only-1", "api-only-2", "gpt-d"]);
  // Of those, only the ones that pass Code's rules are on Code.
  assert.deepEqual(result.withCode, ["gpt-a", "gpt-d"]);
  assert.deepEqual(result.refused, [
    { modelId: "judge-refused", reasons: ["credits_below_floor:7", "unknown_provider"] },
    { modelId: "db-down", reasons: ["write_failed"] },
    { modelId: "refused-both", reasons: ["provider_destination_unproven"] },
  ]);
  // Counted by reason name, the detail after ":" dropped, one count per model.
  assert.deepEqual(result.reasonCounts, { credits_below_floor: 1, unknown_provider: 1, write_failed: 1, provider_destination_unproven: 1 });
  assert.deepEqual(result.codeReasonCounts, { credits_below_floor: 2, no_structured_output: 2 });
  assert.deepEqual(result.codeRefused.map((row) => row.modelId), ["api-only-1", "api-only-2"]);

  // Only the added models left a row: a refused or failed one rolled back with its audit row.
  assert.deepEqual([...state.rows.keys()].sort(), ["api-only-1", "api-only-2", "gpt-a", "gpt-d"]);
  for (const id of ["gpt-a", "gpt-d", "api-only-1", "api-only-2"]) {
    const row = state.rows.get(id);
    assert.equal(row.enabled, true);
    assert.deepEqual(row.profile.channels, id.startsWith("api-only") ? ["api"] : ["code", "api"], id);
    assert.deepEqual(row.profile.capabilities, { toolCalling: "basic", structuredOutput: "none" });
    // Credits stay chat's: nothing overrides them, and nothing raises them.
    assert.equal(row.profile.creditWeight, undefined);
  }
  assert.deepEqual(state.audits.map((entry) => [entry.action, entry.targetId, entry.metadata.batch, entry.metadata.channels]), [
    ["model_catalog.coding_linked", "coding:gpt-a", true, ["code", "api"]],
    ["model_catalog.coding_linked", "coding:api-only-1", true, ["api"]],
    ["model_catalog.coding_linked", "coding:api-only-2", true, ["api"]],
    ["model_catalog.coding_linked", "coding:gpt-d", true, ["code", "api"]],
  ]);
  // Each link was judged on both channels as it would be made, before anything was written.
  assert.equal(state.probes.length, 7);
  for (const probe of state.probes) assert.deepEqual(probe.profile.channels, ["code", "api"]);
  // A model refused by the probe takes no lock and opens no transaction; the rest took the audit chain lock and were activated through the one judge (updateCatalogEntry).
  assert.equal(state.locks, 6);
  assert.deepEqual(state.updates.map((update) => update.modelId), ["gpt-a", "judge-refused", "api-only-1", "db-down", "api-only-2", "gpt-d"]);
  for (const update of state.updates) assert.deepEqual(update.patch, { enabled: true, holdReason: null });
});

test("add-all with no candidate does nothing", async () => {
  reset([chat("gpt-off", { enabled: false }), chat("gpt-have")], ["gpt-have"]);
  const result = await linkAllChatModels({ session });
  assert.deepEqual(result, { attempted: 0, added: [], withCode: [], refused: [], reasonCounts: {}, codeReasonCounts: {}, codeRefused: [] });
  assert.equal(state.rows.size, 0);
  assert.equal(state.audits.length, 0);
  assert.equal(state.locks, 0);
});

test("add-all takes frontier and apex models as candidates; research stays out", async () => {
  // Owner decision 2026-11-22: the coding API's Smart Adaptive sends the hardest work there, and a client may name them.
  reset([chat("gpt-6-2-astra", { usageClass: "frontier", creditWeight: 32 }), chat("api-only-apex", { usageClass: "apex", creditWeight: 80 }), chat("gpt-research", { usageClass: "research" })]);
  const result = await linkAllChatModels({ session });
  assert.equal(result.attempted, 2);
  assert.deepEqual(result.added, ["gpt-6-2-astra", "api-only-apex"]);
  // Code only where Code's own rules pass (here faked per id); the coding API at chat's credits.
  assert.deepEqual(result.withCode, ["gpt-6-2-astra"]);
  for (const id of result.added) assert.equal(state.rows.get(id).profile.creditWeight, undefined, `${id} keeps chat's credits`);
  assert.equal(state.rows.has("gpt-research"), false);
});
