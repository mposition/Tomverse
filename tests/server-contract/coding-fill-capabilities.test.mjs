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
// Mirrors lib/modelCatalogDraftLlm.ts, including its `name`: the fill path tells
// a draft refusal by name (a `.constructor` read is a runtime-loader reach the
// control-plane slice refuses).
class DraftRefusal extends Error {
  name = "DraftRefusal";
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

const { BENCHMARK_STEP_MS, fillLinkCapabilities, capabilitiesNeedFilling } = await import(mod("lib/codingCatalogAdmin.ts"));
const { codingModelPage, defaultCodingCapabilitySources } = await import(mod("lib/modelCatalogCore.ts"));

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
/** What the default answer gives as coding notes; null leaves the default. */
let notesAnswer = null;
const pagesOf = (provider, apiModelId = "gpt-a") => {
  const sources = defaultCodingCapabilitySources(provider);
  return [sources.toolCalling, sources.structuredOutput, codingModelPage(sources, apiModelId)];
};
const deps = (overrides = {}) => ({
  draftLlm: async () => ({
    draftCodingCapabilities: async ({ pages }) => {
      calls.llm += 1;
      return {
        toolCalling: "parallel",
        // A finer value than the two choices: the save writes "supported" (owner decision 2026-11-22).
        structuredOutput: "strict_schema",
        note: "Both stated on the pages.",
        sources: pages.map((page) => page.url),
        draftedAt: "2026-11-21",
        codingNotes: notesAnswer ?? {
          strengths: ["Parallel tool calls in one response", "Strict JSON schema outputs"],
          weaknesses: ["No structured output with some tools"],
          sourceUrls: pages.map((page) => page.url),
        },
      };
    },
  }),
  fetchPage: async (_provider, url) => {
    calls.pages.push(url);
    return { url, text: "page" };
  },
  benchmarkSearch: async () => null,
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
  notesAnswer = null;
};
const fill = (overrides) => fillLinkCapabilities({ modelId: "gpt-a", session, deps: deps(overrides) });

test("one call over the provider's two pages fills the capabilities and sources, leaves the channels, and is audited in the same transaction", async () => {
  reset();
  const result = await fill();
  assert.equal(calls.llm, 1);
  assert.deepEqual(calls.pages, pagesOf("openai"));
  const profile = state.row.profile;
  assert.deepEqual(profile.capabilities, { toolCalling: "parallel", structuredOutput: "supported" });
  assert.equal(profile.evidence.structuredOutput, "supported");
  assert.deepEqual(profile.evidence.sources, pagesOf("openai"));
  assert.equal(profile.evidence.draftedAt, "2026-11-21");
  assert.equal(profile.evidence.note, "Both stated on the pages.");
  // Code is the operator's to tick: nothing here touches the channels.
  assert.deepEqual(profile.channels, ["api"]);
  assert.deepEqual(result.changes, [
    { field: "toolCalling", from: "basic", to: "parallel" },
    { field: "structuredOutput", from: "none", to: "supported" },
    {
      field: "codingNotes",
      from: null,
      to: {
        strengths: ["Parallel tool calls in one response", "Strict JSON schema outputs"],
        weaknesses: ["No structured output with some tools"],
        sources: pagesOf("openai"),
        draftedAt: "2026-11-21",
      },
    },
  ]);
  // The same call wrote the coding notes, standing on the pages it read (owner decision 2026-11-22).
  assert.deepEqual(profile.codingNotes, result.changes.at(-1).to);
  assert.deepEqual(state.audits[0].metadata.codingNotes, profile.codingNotes);
  // The write goes through the one judge's door (updateCatalogEntry), naming the changed fields.
  assert.equal(state.updates.length, 1);
  assert.deepEqual(state.updates[0].provenance, { codingSettings: result.changes });
  assert.equal(state.audits.length, 1);
  assert.equal(state.audits[0].action, "model_catalog.coding_capabilities_filled");
  assert.deepEqual(state.audits[0].metadata.sources, pagesOf("openai"));
  assert.equal(state.audits[0].metadata.structuredOutput, "supported");
  // The row no longer needs filling for the registry's sake.
  assert.equal(capabilitiesNeedFilling(profile), false);
});

test("what needs filling: structured output none, no page read, or no coding notes", () => {
  assert.equal(capabilitiesNeedFilling(registryLink()), true);
  assert.equal(capabilitiesNeedFilling(registryLink({ capabilities: { toolCalling: "basic", structuredOutput: "json_mode" } })), true);
  const read = { sources: ["https://developers.openai.com/api/docs/guides/function-calling"], draftedAt: "2026-11-20", toolCalling: "basic", structuredOutput: "json_mode" };
  const notes = { strengths: ["Parallel tool calls"], weaknesses: [], sources: [read.sources[0]], draftedAt: "2026-11-22" };
  // Capabilities read from the pages but no notes yet: still a target (owner decision 2026-11-22).
  assert.equal(capabilitiesNeedFilling(registryLink({ capabilities: { toolCalling: "basic", structuredOutput: "json_mode" }, evidence: read })), true);
  assert.equal(capabilitiesNeedFilling(registryLink({ capabilities: { toolCalling: "basic", structuredOutput: "json_mode" }, evidence: read, codingNotes: notes })), false);
  assert.equal(capabilitiesNeedFilling(registryLink({ capabilities: { toolCalling: "basic", structuredOutput: "none" }, evidence: read, codingNotes: notes })), true);
  // Two empty lists are no notes.
  assert.equal(
    capabilitiesNeedFilling(registryLink({ capabilities: { toolCalling: "basic", structuredOutput: "json_mode" }, evidence: read, codingNotes: { ...notes, strengths: [] } })),
    true
  );
});

test("coding notes that stand on a page that is not the provider's, or was not read, are refused with nothing written", async () => {
  for (const sourceUrls of [["https://blog.example/claude-is-great"], ["https://developers.openai.com/api/docs/models/gpt-a"]]) {
    reset();
    notesAnswer = { strengths: ["Best coder ever"], weaknesses: [], sourceUrls };
    const before = structuredClone(state.row);
    await assert.rejects(fill(), (error) => error instanceof CatalogRefusal && error.code === "unofficial_source" && error.reasons[0] === sourceUrls[0]);
    assert.equal(calls.llm, 1, "one call, refused after it");
    assert.deepEqual(state.row, before);
    assert.deepEqual(state.audits, []);
    assert.deepEqual(state.updates, []);
  }
});

test("notes with no page to stand on are not written; the capabilities still are", async () => {
  reset();
  notesAnswer = { strengths: ["Fast"], weaknesses: ["Weak at long contexts"], sourceUrls: [] };
  const result = await fill();
  assert.equal(state.row.profile.codingNotes, undefined);
  assert.ok(!result.changes.some((change) => change.field === "codingNotes"));
  assert.deepEqual(state.row.profile.capabilities, { toolCalling: "parallel", structuredOutput: "supported" });
  // A row that already has notes keeps them when a fill finds none.
  const kept = { strengths: ["Parallel tool calls"], weaknesses: [], sources: pagesOf("openai").slice(0, 1), draftedAt: "2026-11-20" };
  reset(registryLink({ codingNotes: kept }));
  notesAnswer = { strengths: [], weaknesses: [], sourceUrls: [] };
  await fill();
  assert.deepEqual(state.row.profile.codingNotes, kept);
});

test("a dedicated row is filled with its coding notes only; with none on the pages nothing is written", async () => {
  const dedicated = {
    source: "dedicated",
    name: "Coder X",
    provider: "openai",
    apiModelId: "coder-x",
    minimumPlan: "Pro",
    capabilities: { toolCalling: "parallel", structuredOutput: "supported", imageInput: false, maxContextTokens: 64_000, maxOutputTokens: 8_192 },
    pricing: { inputUsdPerMTok: 0.2, outputUsdPerMTok: 0.8, creditWeight: 7, verifiedAt: "2026-11-22", sources: ["https://developers.openai.com/api/docs/pricing"] },
    channels: ["code", "api"],
  };
  reset(dedicated);
  const result = await fill();
  assert.equal(calls.llm, 1);
  assert.deepEqual(calls.pages, pagesOf("openai", "coder-x"));
  const profile = state.row.profile;
  // The draft's capabilities and everything else stay; only the notes are added.
  const { codingNotes, ...rest } = profile;
  assert.deepEqual(rest, dedicated);
  assert.deepEqual(codingNotes.strengths, ["Parallel tool calls in one response", "Strict JSON schema outputs"]);
  assert.deepEqual(codingNotes.sources, pagesOf("openai", "coder-x"));
  assert.deepEqual(result.changes.map((change) => change.field), ["codingNotes"]);
  assert.equal(state.audits[0].metadata.source, "dedicated");

  reset(dedicated);
  notesAnswer = { strengths: [], weaknesses: [], sourceUrls: [] };
  const before = structuredClone(state.row);
  await assert.rejects(fill(), (error) => error instanceof CatalogRefusal && error.code === "no_coding_notes");
  assert.deepEqual(state.row, before);
  assert.deepEqual(state.audits, []);
});

test("a provider with JSON mode only (DeepSeek) is filled as supported structured output", async () => {
  // DeepSeek documents response_format json_object and no schema; JSON mode counts (owner decision 2026-11-22).
  reset();
  state.facts = [facts({ provider: "deepseek", apiModelId: "deepseek-chat" })];
  const pages = pagesOf("deepseek");
  const result = await fill({
    draftLlm: async () => ({
      draftCodingCapabilities: async () => {
        calls.llm += 1;
        return { toolCalling: "parallel", structuredOutput: "json_mode", note: "JSON mode: response_format json_object.", sources: pages, draftedAt: "2026-11-22" };
      },
    }),
  });
  assert.equal(calls.llm, 1);
  assert.deepEqual(calls.pages, pages);
  assert.deepEqual(state.row.profile.capabilities, { toolCalling: "parallel", structuredOutput: "supported" });
  assert.deepEqual(result.changes.find((change) => change.field === "structuredOutput"), { field: "structuredOutput", from: "none", to: "supported" });
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

test("the notes read the model's own page; a models page that does not load is left out and the fill goes on", async () => {
  // OpenAI has a page per model: the API model id names it.
  reset();
  state.facts = [facts({ apiModelId: "gpt-6.1-terra" })];
  await fill();
  assert.equal(calls.pages[2], "https://developers.openai.com/api/docs/models/gpt-6.1-terra.md");
  assert.deepEqual(state.row.profile.evidence.sources, pagesOf("openai", "gpt-6.1-terra"));

  // A model with no page of its own: the two feature pages still answer.
  reset();
  const [toolPage, structuredPage, modelPage] = pagesOf("openai");
  await fill({
    fetchPage: async (_provider, url) => {
      calls.pages.push(url);
      if (url === modelPage) throw new DraftRefusal("fetch_failed", `${url} http_404`);
      return { url, text: "page" };
    },
  });
  assert.equal(calls.llm, 1);
  assert.deepEqual(calls.pages, [toolPage, structuredPage, modelPage]);
  assert.deepEqual(state.row.profile.evidence.sources, [toolPage, structuredPage]);
  assert.deepEqual(state.row.profile.capabilities, { toolCalling: "parallel", structuredOutput: "supported" });
});

test("with the benchmark search on, the first of the provider's own pages it names that loads is read for the notes", async () => {
  const searched = [];
  const search = (urls) => async () => ({
    findPages: async (input) => {
      searched.push(input);
      return urls;
    },
  });
  const budgets = [];
  const announcement = "https://openai.com/index/gpt-a";
  const card = "https://openai.com/index/gpt-a-system-card";
  reset();
  notesAnswer = { strengths: ["SWE-bench Verified 80%"], weaknesses: [], sourceUrls: [announcement] };
  await fill({
    // A page off the provider's hosts is never read; one that does not load is skipped; only the first that loads is kept.
    benchmarkSearch: search(["https://blog.example.com/gpt-a-benchmarks", "https://openai.com/index/missing", announcement, card]),
    fetchPage: async (_provider, url, maxMs) => {
      calls.pages.push(url);
      if (url.startsWith("https://openai.com/")) budgets.push(maxMs);
      if (url.endsWith("/missing")) throw new DraftRefusal("fetch_failed", `${url} http_404`);
      return { url, text: "page" };
    },
  });
  // The search and its pages share one budget, inside the Admin client's wait.
  assert.deepEqual(searched, [{ provider: "openai", apiModelId: "gpt-a", name: "GPT A", timeoutMs: 20_000 }]);
  assert.equal(budgets.length, 2);
  for (const ms of budgets) assert.ok(ms > 0 && ms <= BENCHMARK_STEP_MS, String(ms));
  assert.deepEqual(calls.pages, [...pagesOf("openai"), "https://openai.com/index/missing", announcement]);
  assert.equal(calls.llm, 1);
  // The notes may stand on it; the evidence keeps its three capability pages.
  assert.ok(state.row.profile.codingNotes.sources.includes(announcement));
  assert.deepEqual(state.row.profile.evidence.sources, pagesOf("openai"));

  // A search that fails or finds nothing leaves the fill as it was.
  for (const benchmarkSearch of [search([]), async () => ({ findPages: async () => { throw new Error("search 500"); } })]) {
    reset();
    await fill({ benchmarkSearch });
    assert.deepEqual(calls.pages, pagesOf("openai"));
    assert.equal(calls.llm, 1);
    assert.equal(state.audits.length, 1);
  }
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

test("it needs the draft model and pages for the provider, and a row that parses", async () => {
  reset();
  await assert.rejects(fill({ draftLlm: async () => null }), (error) => error.code === "draft_llm_not_configured" && error.status === 409);
  assert.deepEqual(calls.pages, [], "nothing is fetched while the draft model is off");
  reset();
  state.facts = [facts({ provider: "openrouter" })];
  await assert.rejects(fill(), (error) => error.code === "no_capability_source");
  assert.equal(calls.llm, 0);
  // A row whose stored profile does not parse is refused (a dedicated row that parses takes its notes, above).
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
  state.refuseUpdate = new CatalogRefusal("not_admitted", ["no_structured_output"]);
  await assert.rejects(
    fill({
      draftLlm: async () => ({
        draftCodingCapabilities: async ({ pages }) => ({ toolCalling: "basic", structuredOutput: "none", note: "", sources: pages.map((page) => page.url), draftedAt: "2026-11-21" }),
      }),
    }),
    (error) => error instanceof CatalogRefusal && error.code === "not_admitted" && error.reasons.includes("no_structured_output")
  );
  assert.deepEqual(state.row, before);
  assert.deepEqual(state.audits, []);
});

test("a documentation answer of no tool calling never lowers a chat link's: it keeps its value, and the rest is still written", async () => {
  const answerNone = (structuredOutput = "json_mode") => ({
    draftLlm: async () => ({
      draftCodingCapabilities: async ({ pages }) => {
        calls.llm += 1;
        return {
          toolCalling: "none",
          structuredOutput,
          note: "The pages do not name this model.",
          sources: pages.map((page) => page.url),
          draftedAt: "2026-11-22",
          codingNotes: { strengths: ["JSON mode output"], weaknesses: [], sourceUrls: pages.map((page) => page.url).slice(0, 1) },
        };
      },
    }),
  });
  // A serving link on the registry's value: tool calling stays, structured output and the notes are written.
  reset(registryLink({ channels: ["code", "api"] }), true);
  const result = await fill(answerNone());
  assert.equal(calls.llm, 1);
  const profile = state.row.profile;
  assert.deepEqual(profile.capabilities, { toolCalling: "basic", structuredOutput: "supported" });
  // The evidence records what the pages said; the audit row names the answer that was not taken.
  assert.equal(profile.evidence.toolCalling, "none");
  assert.equal(profile.evidence.structuredOutput, "supported");
  assert.deepEqual(profile.codingNotes.strengths, ["JSON mode output"]);
  assert.ok(!result.changes.some((change) => change.field === "toolCalling"));
  assert.deepEqual(result.changes.map((change) => change.field), ["structuredOutput", "codingNotes"]);
  assert.equal(state.audits[0].metadata.toolCalling, "basic");
  assert.equal(state.audits[0].metadata.answeredToolCalling, "none");
  // The judge saw a profile that still calls tools.
  assert.equal(state.updates[0].patch.profile.capabilities.toolCalling, "basic");

  // A link already at parallel keeps parallel.
  reset(registryLink({ capabilities: { toolCalling: "parallel", structuredOutput: "none" } }));
  await fill(answerNone());
  assert.equal(state.row.profile.capabilities.toolCalling, "parallel");

  // A link the operator set to none stays none: a fill neither lowers nor overrides the operator.
  reset(registryLink({ capabilities: { toolCalling: "none", structuredOutput: "none" } }));
  const kept = await fill(answerNone());
  assert.equal(state.row.profile.capabilities.toolCalling, "none");
  assert.ok(!kept.changes.some((change) => change.field === "toolCalling"));
  assert.equal(state.audits[0].metadata.answeredToolCalling, undefined);

  // An answer that names support is still taken as it is, and no answered value is recorded.
  reset();
  await fill();
  assert.equal(state.row.profile.capabilities.toolCalling, "parallel");
  assert.equal(state.audits[0].metadata.answeredToolCalling, undefined);
});

test("a documentation answer of no structured output never lowers a serving chat link's: Code keeps it", async () => {
  // 2026-11-23: pages that showed one flagship model only took Code from eight serving links in one run.
  const answerNone = {
    draftLlm: async () => ({
      draftCodingCapabilities: async ({ pages }) => {
        calls.llm += 1;
        return { toolCalling: "none", structuredOutput: "none", note: "The pages do not name this model.", sources: pages.map((page) => page.url), draftedAt: "2026-11-23" };
      },
    }),
  };
  reset(registryLink({ channels: ["code", "api"], capabilities: { toolCalling: "basic", structuredOutput: "supported" } }), true);
  const result = await fill(answerNone);
  assert.equal(calls.llm, 1);
  assert.deepEqual(state.row.profile.capabilities, { toolCalling: "basic", structuredOutput: "supported" });
  // The judge saw the kept values; only the evidence moved, and it records the answer.
  assert.deepEqual(state.updates[0].patch.profile.capabilities, { toolCalling: "basic", structuredOutput: "supported" });
  assert.equal(state.row.profile.evidence.structuredOutput, "none");
  assert.deepEqual(result.changes, []);
  assert.equal(state.audits[0].metadata.structuredOutput, "supported");
  assert.equal(state.audits[0].metadata.answeredStructuredOutput, "none");

  // A link already at none stays none, with no answered value recorded.
  reset(registryLink());
  await fill(answerNone);
  assert.equal(state.row.profile.capabilities.structuredOutput, "none");
  assert.equal(state.audits[0].metadata.answeredStructuredOutput, undefined);

  // An answer that names support still raises it.
  reset(registryLink());
  await fill();
  assert.equal(state.row.profile.capabilities.structuredOutput, "supported");
  assert.equal(state.audits[0].metadata.answeredStructuredOutput, undefined);
});
