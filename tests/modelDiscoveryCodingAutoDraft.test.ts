import assert from "node:assert/strict";
import test from "node:test";

import {
  CODING_AUTO_DRAFT_MAX_PER_RUN,
  MODEL_DISCOVERY_CODING_AUTO_DRAFT_ENV,
  codingAutoDraftCandidates,
  codingAutoDraftEnabled,
  runCodingAutoDraft,
  type CodingAutoDraftDeps,
} from "../lib/modelDiscoveryCodingAutoDraft.ts";
import { DraftRefusal } from "../lib/modelCatalogDraftLlm.ts";

const ON = { [MODEL_DISCOVERY_CODING_AUTO_DRAFT_ENV]: "true" };
const TERMS = {
  allowsResaleAndCodingAgent: true,
  termsUrl: "https://www.alibabacloud.com/help/en/legal/terms",
  retentionUrl: "https://www.alibabacloud.com/help/en/legal/retention",
  processingRegion: "sg",
  checkedAt: "2026-11-01",
  sources: ["https://www.alibabacloud.com/help/en/legal/terms"],
};
const record = (provider: string, terms: typeof TERMS | null) => ({
  provider,
  terms,
  invalid: false,
  draft: null,
  draftCreatedAt: null,
  updatedByEmail: null,
  updatedAt: new Date(0),
});

type Llm = Awaited<ReturnType<CodingAutoDraftDeps["draftLlm"]>>;

/** Every dependency counts its calls; nothing here can reach a database, the network or a paid model. */
const harness = (overrides: Partial<CodingAutoDraftDeps> & { existing?: string[]; profile?: () => Promise<unknown> } = {}) => {
  const calls = {
    draftLlm: 0,
    providerTerms: 0,
    entryExists: 0,
    pages: [] as string[],
    pageCaps: [] as number[],
    clock: 1_000_000,
    llm: [] as string[],
    stored: [] as Array<{ modelId: string; draft: unknown }>,
  };
  const { existing, profile, ...depOverrides } = overrides;
  const deps: CodingAutoDraftDeps = {
    draftLlm: async () => {
      calls.draftLlm += 1;
      return {
        draftImagePrices: async () => {
          throw new Error("not used");
        },
        draftCodingProfile: async ({ apiModelId }: { apiModelId: string }) => {
          calls.llm.push(apiModelId);
          return profile ? profile() : { name: apiModelId };
        },
        draftCodingCapabilities: async () => {
          throw new Error("not used");
        },
        draftProviderTerms: async () => {
          throw new Error("not used");
        },
      } as unknown as Llm;
    },
    providerTerms: async () => {
      calls.providerTerms += 1;
      return [record("qwen", TERMS)];
    },
    entryExists: async (modelId) => {
      calls.entryExists += 1;
      return (existing ?? []).includes(modelId);
    },
    fetchPage: async (_provider, url, maxMs) => {
      calls.pages.push(url);
      calls.pageCaps.push(maxMs);
      return { url, text: "page" };
    },
    store: async (input) => {
      calls.stored.push(input);
      return "stored" as const;
    },
    now: () => calls.clock,
    ...depOverrides,
  };
  return { calls, deps };
};

const qwen = (apiModel: string) => ({ provider: "qwen", apiModel, observedVia: [{ provider: "qwen", apiModel }] });

test("the switch is off unless it is exactly the string true, and off makes no call of any kind", async () => {
  for (const value of [undefined, "", "1", "TRUE", "yes", " true"]) {
    assert.equal(codingAutoDraftEnabled({ [MODEL_DISCOVERY_CODING_AUTO_DRAFT_ENV]: value }), false, String(value));
  }
  assert.equal(codingAutoDraftEnabled({ [MODEL_DISCOVERY_CODING_AUTO_DRAFT_ENV]: "true" }), true);
  const { calls, deps } = harness();
  const summary = await runCodingAutoDraft({ candidates: [qwen("qwen3-coder-flash")], env: {}, deps });
  assert.equal(summary.status, "off");
  assert.deepEqual(
    [calls.draftLlm, calls.providerTerms, calls.entryExists, calls.pages.length, calls.llm.length, calls.stored.length],
    [0, 0, 0, 0, 0, 0]
  );
});

test("no configured draft model means no call, and the summary says why", async () => {
  const { calls, deps } = harness({ draftLlm: async () => null });
  const summary = await runCodingAutoDraft({ candidates: [qwen("qwen3-coder-flash")], env: ON, deps });
  assert.equal(summary.status, "draft_llm_not_configured");
  assert.equal(calls.pages.length + calls.llm.length + calls.stored.length, 0);
});

test("a new coding model is drafted from its price page and the provider's confirmed terms pages", async () => {
  const { calls, deps } = harness();
  const summary = await runCodingAutoDraft({ candidates: [qwen("qwen3-coder-flash")], env: ON, deps });
  assert.deepEqual(summary.drafted, ["qwen3-coder-flash"]);
  assert.deepEqual(calls.llm, ["qwen3-coder-flash"]);
  assert.deepEqual(calls.pages, [
    "https://www.alibabacloud.com/help/en/model-studio/model-pricing",
    TERMS.termsUrl,
    TERMS.retentionUrl,
  ]);
  assert.equal(calls.stored.length, 1);
  assert.equal(calls.stored[0].modelId, "qwen3-coder-flash");
});

test("at most five paid calls per run, and the rest stay for the operator's button", async () => {
  assert.equal(CODING_AUTO_DRAFT_MAX_PER_RUN, 5);
  const { calls, deps } = harness();
  const candidates = Array.from({ length: 8 }, (_, index) => qwen(`qwen3-coder-${index}`));
  const summary = await runCodingAutoDraft({ candidates, env: ON, deps });
  assert.equal(calls.llm.length, 5);
  assert.equal(summary.drafted.length, 5);
  assert.equal(summary.stopped, "cap");
});

test("a failed call counts against the cap and is not retried", async () => {
  const { calls, deps } = harness({
    profile: async () => {
      throw new DraftRefusal("draft_rejected", "retention_source_missing");
    },
  });
  const candidates = Array.from({ length: 7 }, (_, index) => qwen(`qwen3-coder-${index}`));
  const summary = await runCodingAutoDraft({ candidates, env: ON, deps });
  assert.equal(calls.llm.length, 5);
  assert.equal(summary.failed.length, 5);
  assert.deepEqual(summary.failed[0], { apiModel: "qwen3-coder-0", code: "draft_rejected" });
  assert.equal(summary.stopped, "cap");
  assert.equal(calls.stored.length, 0);
});

test("a model the coding catalogue already holds is skipped without a call", async () => {
  const { calls, deps } = harness({ existing: ["qwen3-coder-flash"] });
  const summary = await runCodingAutoDraft({
    candidates: [qwen("qwen3-coder-flash"), qwen("qwen3-coder-plus")],
    env: ON,
    deps,
  });
  assert.deepEqual(summary.skipped, [{ apiModel: "qwen3-coder-flash", reason: "already_in_catalogue" }]);
  assert.deepEqual(calls.llm, ["qwen3-coder-plus"]);
});

test("the same model seen twice in one run is one draft", async () => {
  const { calls, deps } = harness();
  const summary = await runCodingAutoDraft({
    candidates: [qwen("qwen3-coder-flash"), qwen("Qwen3-Coder-Flash")],
    env: ON,
    deps,
  });
  assert.equal(calls.llm.length, 1);
  assert.deepEqual(summary.skipped, [{ apiModel: "Qwen3-Coder-Flash", reason: "duplicate" }]);
});

test("a provider a draft cannot read is skipped without a call", async () => {
  const { calls, deps } = harness();
  const summary = await runCodingAutoDraft({
    candidates: [
      {
        provider: "together",
        apiModel: "Qwen/Qwen3-Coder",
        observedVia: [{ provider: "together", apiModel: "Qwen/Qwen3-Coder" }],
      },
    ],
    env: ON,
    deps,
  });
  assert.deepEqual(summary.skipped, [{ apiModel: "Qwen/Qwen3-Coder", reason: "not_draft_provider" }]);
  assert.equal(calls.llm.length + calls.pages.length, 0);
});

test("a draft provider with no confirmed terms or no default price page is skipped before the paid call", async () => {
  const noTerms = harness({ providerTerms: async () => [record("qwen", null)] });
  const first = await runCodingAutoDraft({ candidates: [qwen("qwen3-coder-flash")], env: ON, deps: noTerms.deps });
  assert.deepEqual(first.skipped, [{ apiModel: "qwen3-coder-flash", reason: "provider_terms_missing" }]);
  assert.equal(noTerms.calls.llm.length + noTerms.calls.pages.length, 0);

  // Moonshot has confirmed terms here but no default price page in the code.
  const noPrice = harness({ providerTerms: async () => [record("moonshot", TERMS)] });
  const second = await runCodingAutoDraft({
    candidates: [
      { provider: "moonshot", apiModel: "kimi-k3-coder", observedVia: [{ provider: "moonshot", apiModel: "kimi-k3-coder" }] },
    ],
    env: ON,
    deps: noPrice.deps,
  });
  assert.deepEqual(second.skipped, [{ apiModel: "kimi-k3-coder", reason: "no_default_source" }]);
  assert.equal(noPrice.calls.llm.length + noPrice.calls.pages.length, 0);
});

test("a page that will not load costs no model call and does not stop the next model", async () => {
  let first = true;
  const { calls, deps } = harness({
    fetchPage: async (_provider, url) => {
      if (first) {
        first = false;
        throw new DraftRefusal("fetch_failed", url);
      }
      return { url, text: "page" };
    },
  });
  const summary = await runCodingAutoDraft({
    candidates: [qwen("qwen3-coder-a"), qwen("qwen3-coder-b")],
    env: ON,
    deps,
  });
  assert.deepEqual(summary.failed, [{ apiModel: "qwen3-coder-a", code: "fetch_failed" }]);
  assert.deepEqual(calls.llm, ["qwen3-coder-b"]);
  assert.deepEqual(summary.drafted, ["qwen3-coder-b"]);
});

test("a page read that finishes late starts no model call and no store", async () => {
  const { calls, deps } = harness({
    fetchPage: async (_provider, url, maxMs) => {
      calls.pages.push(url);
      calls.pageCaps.push(maxMs);
      // The read returns, but only after the deadline has gone.
      calls.clock = 1_000_000 + 200_000;
      return { url, text: "page" };
    },
  });
  const summary = await runCodingAutoDraft({
    candidates: [qwen("qwen3-coder-a"), qwen("qwen3-coder-b")],
    env: ON,
    deadlineAt: 1_000_000 + 150_000,
    deps,
  });
  assert.equal(calls.llm.length, 0);
  assert.equal(calls.stored.length, 0);
  assert.equal(summary.stopped, "time_budget");
  assert.equal(summary.drafted.length, 0);
  // Only the first page was asked for; nothing else was started after the deadline.
  assert.equal(calls.pages.length, 1);
});

test("a page read is capped inside what is left once the model call window is reserved", async () => {
  const { calls, deps } = harness();
  await runCodingAutoDraft({
    candidates: [qwen("qwen3-coder-a")],
    env: ON,
    deadlineAt: 1_000_000 + 130_000,
    deps,
  });
  // 130 s left, 95 s kept for the model call (90 s timeout plus the store margin).
  assert.equal(calls.pageCaps.length, 3);
  for (const cap of calls.pageCaps) assert.equal(cap, 35_000);
  assert.equal(calls.llm.length, 1);
});

test("too little time for the model call means no model call and no page read", async () => {
  const { calls, deps } = harness();
  const summary = await runCodingAutoDraft({
    candidates: [qwen("qwen3-coder-a")],
    env: ON,
    // The model call needs 95 s; 60 s is left.
    deadlineAt: 1_000_000 + 60_000,
    deps,
  });
  assert.equal(summary.stopped, "time_budget");
  assert.equal(calls.pages.length + calls.llm.length + calls.stored.length, 0);
});

test("the model call own timeout is an unknown outcome: recorded, not retried, and the run stops", async () => {
  const timeout = Object.assign(new Error("timed out"), { name: "TimeoutError" });
  const { calls, deps } = harness({
    profile: async () => {
      throw timeout;
    },
  });
  const summary = await runCodingAutoDraft({
    candidates: [qwen("qwen3-coder-a"), qwen("qwen3-coder-b")],
    env: ON,
    deps,
  });
  assert.deepEqual(summary.failed, [{ apiModel: "qwen3-coder-a", code: "timeout_outcome_unknown" }]);
  assert.equal(summary.stopped, "unknown_outcome");
  assert.deepEqual(calls.llm, ["qwen3-coder-a"]);
  assert.equal(calls.stored.length, 0);
});

test("a row that appeared while the model call ran is reported as existing, not drafted", async () => {
  const { calls, deps } = harness({
    store: async (input) => {
      calls.stored.push(input);
      return "exists" as const;
    },
  });
  const summary = await runCodingAutoDraft({ candidates: [qwen("qwen3-coder-a")], env: ON, deps });
  assert.deepEqual(summary.drafted, []);
  assert.deepEqual(summary.skipped, [{ apiModel: "qwen3-coder-a", reason: "already_in_catalogue" }]);
});

test("candidates are the code-specialized scan items only, never the weekly research proposals", () => {
  const picked = codingAutoDraftCandidates({
    scan: [
      { provider: "qwen", apiModel: "qwen3-coder-flash" },
      { provider: "openai", apiModel: "gpt-5.6-sol" },
      { provider: "openai", apiModel: "gpt-image-3" },
      { provider: "openai", apiModel: "gpt-6-codex" },
    ],
  });
  assert.deepEqual(
    picked.map((item) => item.apiModel),
    ["qwen3-coder-flash", "gpt-6-codex"]
  );
});
