import assert from "node:assert/strict";
import { resolve } from "node:path";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";

// Adding chat models to the coding catalogue (owner decision 2026-11-21): one
// at a time and all at once, both from the chat registry with no LLM call. The
// all-at-once run commits one transaction per model -- the link, its audit row
// and the activation -- so a refused or failed model leaves nothing behind and
// never stops the rest.

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
const state = { rows: new Map(), audits: [], preexisting: [], facts: [], updates: [], locks: 0 };
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
mock.module(mod("lib/modelCatalog.ts"), { namedExports: { loadChatModelFacts: async () => state.facts } });
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

test("add-all links every candidate on Code and the coding API, activates it, and counts refusals by reason without stopping", async () => {
  reset(
    [
      chat("gpt-a"),
      chat("judge-refused"),
      chat("db-down"),
      chat("judge-refused-too"),
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
  assert.equal(result.attempted, 5);
  // The two models around the failures were still added.
  assert.deepEqual(result.added, ["gpt-a", "gpt-d"]);
  assert.deepEqual(result.refused, [
    { modelId: "judge-refused", reasons: ["credits_below_floor:7", "unknown_provider"] },
    { modelId: "db-down", reasons: ["write_failed"] },
    { modelId: "judge-refused-too", reasons: ["credits_below_floor:9"] },
  ]);
  // Counted by reason name, the detail after ":" dropped, one count per model.
  assert.deepEqual(result.reasonCounts, { credits_below_floor: 2, unknown_provider: 1, write_failed: 1 });

  // Only the added models left a row: a refused or failed one rolled back with its audit row.
  assert.deepEqual([...state.rows.keys()].sort(), ["gpt-a", "gpt-d"]);
  for (const id of ["gpt-a", "gpt-d"]) {
    const row = state.rows.get(id);
    assert.equal(row.enabled, true);
    assert.deepEqual(row.profile.channels, ["code", "api"]);
    assert.deepEqual(row.profile.capabilities, { toolCalling: "basic", structuredOutput: "none" });
    // Credits stay chat's: nothing overrides them.
    assert.equal(row.profile.creditWeight, undefined);
  }
  assert.deepEqual(state.audits.map((entry) => [entry.action, entry.targetId, entry.metadata.batch]), [
    ["model_catalog.coding_linked", "coding:gpt-a", true],
    ["model_catalog.coding_linked", "coding:gpt-d", true],
  ]);
  // Each model took the audit chain lock, and was activated through the one judge (updateCatalogEntry).
  assert.equal(state.locks, 5);
  assert.deepEqual(state.updates.map((update) => update.modelId), ["gpt-a", "judge-refused", "db-down", "judge-refused-too", "gpt-d"]);
  for (const update of state.updates) assert.deepEqual(update.patch, { enabled: true, holdReason: null });
});

test("add-all with no candidate does nothing", async () => {
  reset([chat("gpt-off", { enabled: false }), chat("gpt-have")], ["gpt-have"]);
  const result = await linkAllChatModels({ session });
  assert.deepEqual(result, { attempted: 0, added: [], refused: [], reasonCounts: {} });
  assert.equal(state.rows.size, 0);
  assert.equal(state.audits.length, 0);
  assert.equal(state.locks, 0);
});
