import assert from "node:assert/strict";
import { resolve } from "node:path";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";

// "Fill capabilities with the LLM" (owner decision 2026-11-21): one paid LLM
// call for one chat link, reading the provider's default tool calling and
// structured output pages. The LLM and the page fetch are injected; no real
// call is made. A failure leaves the row as it was, a timeout is reported and
// not retried, the channels never change, and the write is audited in the
// caller's transaction.

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
class DraftRefusal extends Error {
  constructor(code, detail = null) {
    super(code);
    this.code = code;
    this.detail = detail;
  }
}

const state = { row: null, audits: [], updates: [], refuseUpdate: null, facts: [] };
const tx = { modelCatalogEntry: { findUnique: async () => state.row } };

mock.module(mod("lib/prisma.ts"), {
  namedExports: {
    prisma: {
      modelCatalogEntry: { findUnique: async () => state.row },
      $transaction: async (body) => {
        const before = { row: state.row, audits: [...state.audits] };
        try {
          return await body(tx);
        } catch (error) {
          state.row = before.row;
          state.audits = before.audits;
          throw error;
        }
      },
    },
  },
});
mock.module(mod("lib/adminAudit.ts"), {
  namedExports: {
    takeAuditChainLock: async () => {},
    writeAdminAuditLog: async (entry) => {
      assert.equal(entry.tx, tx, "the audit row is written in the caller's transaction");
      state.audits.push(entry);
    },
  },
});
mock.module(mod("lib/modelCatalog.ts"), {
  namedExports: {
    loadChatModelFacts: async () => state.facts,
    loadCodingProviderTerms: async () => [],
    codingLookups: () => ({}),
    resolveCodingRow: () => ({}),
  },
});
mock.module(mod("lib/modelCatalogAdmin.ts"), {
  namedExports: {
    CatalogRefusal,
    updateCatalogEntry: async (input) => {
      assert.equal(input.tx, tx, "the profile is written in the same transaction as its audit row");
      state.updates.push(input);
      if (state.refuseUpdate) throw state.refuseUpdate;
      state.row = { ...state.row, profile: input.patch.profile };
      return state.row;
    },
  },
});

const { fillLinkCapabilities, capabilitiesNeedFilling } = await import(mod("lib/codingCatalogAdmin.ts"));
const { defaultCodingCapabilitySources } = await import(mod("lib/modelCatalogCore.ts"));

const session = { user: { id: "admin-1", email: "owner@example.com" } };
const facts = (overrides = {}) => ({
  id: "gpt-a",
  name: "GPT A",
  provider: "openai",
  apiModelId: "gpt-a",
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
const registryLink = (overrides = {}) => ({
  source: "chat",
  registryModelId: "gpt-a",
  capabilities: { toolCalling: "basic", structuredOutput: "none" },
  channels: ["api"],
  evidence: { sources: [], draftedAt: "2026-11-21", toolCalling: "basic", structuredOutput: "none" },
  ...overrides,
});

const calls = { llm: 0, pages: [] };
const pagesOf = (provider) => {
  const sources = defaultCodingCapabilitySources(provider);
  return [sources.toolCalling, sources.structuredOutput];
};
const deps = (overrides = {}) => ({
  draftLlm: async () => ({
    draftCodingCapabilities: async ({ pages }) => {
      calls.llm += 1;
      return {
        toolCalling: "parallel",
        structuredOutput: "strict_schema",
        note: "Both stated on the pages.",
        sources: pages.map((page) => page.url),
        draftedAt: "2026-11-21",
      };
    },
  }),
  fetchPage: async (_provider, url) => {
    calls.pages.push(url);
    return { url, text: "page" };
  },
  ...overrides,
});
const reset = (profile = registryLink(), enabled = null) => {
  state.row = { category: "coding", modelId: "gpt-a", enabled, profile };
  state.audits = [];
  state.updates = [];
  state.refuseUpdate = null;
  state.facts = [facts()];
  calls.llm = 0;
  calls.pages = [];
};
const fill = (overrides) => fillLinkCapabilities({ modelId: "gpt-a", session, deps: deps(overrides) });

test("one call over the provider's two pages fills the capabilities and sources, leaves the channels, and is audited in the same transaction", async () => {
  reset();
  const result = await fill();
  assert.equal(calls.llm, 1);
  assert.deepEqual(calls.pages, pagesOf("openai"));
  const profile = state.row.profile;
  assert.deepEqual(profile.capabilities, { toolCalling: "parallel", structuredOutput: "strict_schema" });
  assert.deepEqual(profile.evidence.sources, pagesOf("openai"));
  assert.equal(profile.evidence.draftedAt, "2026-11-21");
  assert.equal(profile.evidence.note, "Both stated on the pages.");
  // Code is the operator's to tick: nothing here touches the channels.
  assert.deepEqual(profile.channels, ["api"]);
  assert.deepEqual(result.changes, [
    { field: "toolCalling", from: "basic", to: "parallel" },
    { field: "structuredOutput", from: "none", to: "strict_schema" },
  ]);
  // The write goes through the one judge's door (updateCatalogEntry), naming the changed fields.
  assert.equal(state.updates.length, 1);
  assert.deepEqual(state.updates[0].provenance, { codingSettings: result.changes });
  assert.equal(state.audits.length, 1);
  assert.equal(state.audits[0].action, "model_catalog.coding_capabilities_filled");
  assert.deepEqual(state.audits[0].metadata.sources, pagesOf("openai"));
  assert.equal(state.audits[0].metadata.structuredOutput, "strict_schema");
  // The row no longer needs filling for the registry's sake.
  assert.equal(capabilitiesNeedFilling(profile), false);
});

test("what needs filling: structured output none, or no page read", () => {
  assert.equal(capabilitiesNeedFilling(registryLink()), true);
  assert.equal(capabilitiesNeedFilling(registryLink({ capabilities: { toolCalling: "basic", structuredOutput: "json_mode" } })), true);
  const read = { sources: ["https://developers.openai.com/api/docs/guides/function-calling"], draftedAt: "2026-11-20", toolCalling: "basic", structuredOutput: "json_mode" };
  assert.equal(capabilitiesNeedFilling(registryLink({ capabilities: { toolCalling: "basic", structuredOutput: "json_mode" }, evidence: read })), false);
  assert.equal(capabilitiesNeedFilling(registryLink({ capabilities: { toolCalling: "basic", structuredOutput: "none" }, evidence: read })), true);
});

test("a timeout is an unknown outcome: reported, never retried, the row unchanged and nothing audited", async () => {
  reset();
  const before = structuredClone(state.row);
  const timeout = Object.assign(new Error("timed out"), { name: "TimeoutError" });
  await assert.rejects(
    fill({ draftLlm: async () => ({ draftCodingCapabilities: async () => { calls.llm += 1; throw timeout; } }) }),
    (error) => error instanceof CatalogRefusal && error.code === "timeout_outcome_unknown" && error.status === 504
  );
  assert.equal(calls.llm, 1, "no second call");
  assert.deepEqual(state.row, before);
  assert.deepEqual(state.audits, []);
  assert.deepEqual(state.updates, []);
});

test("a failed call or page leaves the row as it was, and a refused page costs no model call", async () => {
  reset();
  const before = structuredClone(state.row);
  await assert.rejects(
    fill({ draftLlm: async () => ({ draftCodingCapabilities: async () => { calls.llm += 1; throw new Error("provider 500"); } }) }),
    (error) => error instanceof CatalogRefusal && error.code === "draft_failed" && error.status === 502
  );
  assert.equal(calls.llm, 1);
  calls.llm = 0;
  await assert.rejects(
    fill({ fetchPage: async (_provider, url) => { throw new DraftRefusal("fetch_failed", url); } }),
    (error) => error instanceof CatalogRefusal && error.code === "fetch_failed" && error.status === 422
  );
  assert.equal(calls.llm, 0, "the model is not called when a page could not be read");
  assert.deepEqual(state.row, before);
  assert.deepEqual(state.audits, []);
});

test("every page the answer stands on must be the provider's own, or nothing is written", async () => {
  reset();
  const before = structuredClone(state.row);
  await assert.rejects(
    fill({
      draftLlm: async () => ({
        draftCodingCapabilities: async () => ({
          toolCalling: "parallel",
          structuredOutput: "strict_schema",
          note: "",
          sources: ["https://blog.example/openai-tools"],
          draftedAt: "2026-11-21",
        }),
      }),
    }),
    (error) => error instanceof CatalogRefusal && error.code === "unofficial_source"
  );
  assert.deepEqual(state.row, before);
  assert.deepEqual(state.audits, []);
});

test("it needs the draft model and pages for the provider, and only a chat link is filled", async () => {
  reset();
  await assert.rejects(fill({ draftLlm: async () => null }), (error) => error.code === "draft_llm_not_configured" && error.status === 409);
  assert.deepEqual(calls.pages, [], "nothing is fetched while the draft model is off");
  reset();
  state.facts = [facts({ provider: "openrouter" })];
  await assert.rejects(fill(), (error) => error.code === "no_capability_source");
  assert.equal(calls.llm, 0);
  reset({ name: "Dedicated", provider: "qwen" });
  await assert.rejects(fill(), (error) => error.code === "settings_linked_only");
  reset();
  state.row = null;
  await assert.rejects(fill(), (error) => error.code === "unknown_model");
  reset();
  state.facts = [];
  await assert.rejects(fill(), (error) => error.code === "chat_model_missing");
  assert.equal(calls.llm, 0);
});

test("a serving row the new values would make refused keeps its old values, and nothing is audited", async () => {
  reset(registryLink({ channels: ["code", "api"], capabilities: { toolCalling: "basic", structuredOutput: "json_mode" } }), true);
  const before = structuredClone(state.row);
  state.refuseUpdate = new CatalogRefusal("not_admitted", ["no_tool_calling"]);
  await assert.rejects(
    fill({
      draftLlm: async () => ({
        draftCodingCapabilities: async ({ pages }) => ({ toolCalling: "none", structuredOutput: "json_mode", note: "", sources: pages.map((page) => page.url), draftedAt: "2026-11-21" }),
      }),
    }),
    (error) => error instanceof CatalogRefusal && error.code === "not_admitted" && error.reasons.includes("no_tool_calling")
  );
  assert.deepEqual(state.row, before);
  assert.deepEqual(state.audits, []);
});
