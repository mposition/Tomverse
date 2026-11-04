import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

import {
  MARKETING_CODEX_DISABLED_FEATURES,
  marketingCodexArguments,
  marketingCodexChannel,
  marketingCodexPrompt,
  marketingLlmChannelFromEnv,
  readMarketingCodexEvents,
} from "@/lib/marketingCodexChannelCore";
import { marketingGeneratorWorkerConfig } from "@/lib/marketingGeneratorCycleCore";
import { runMarketingLlmCall } from "@/lib/marketingLlmClientCore";

const SECRET = "x".repeat(40);
const PIN = {
  model: "gpt-6.1-sol",
  tokenizerFamily: "o200k",
  projectId: "key-scoped",
  region: "us",
  tiers: ["default"],
  contextWindowTokens: 128_000,
  worstInputMicroUsdPerMillion: 800_000,
  worstOutputMicroUsdPerMillion: 3_200_000,
  maxOutputTokens: 4_096,
  priceVersion: "fixture-v1",
  verifiedAt: "2026-10-01T00:00:00.000Z",
  expiresAt: "2026-12-30T00:00:00.000Z",
  source: "https://example.invalid/pricing",
};

// The shape measured from codex-cli 0.160.0 on the box, 2026-11-04.
const events = (...lines) => lines.map((line) => JSON.stringify(line)).join("\n");
const STARTED = { type: "thread.started", thread_id: "t" };
const NARRATION = { type: "item.completed", item: { type: "agent_message", text: "I'll check the site." } };
const SEARCH = {
  type: "item.completed",
  item: {
    type: "web_search",
    query: "site:example.com pricing",
    action: { type: "search", query: "site:example.com pricing" },
    results: [
      { type: "text_result", domain: "example.com", url: "https://example.com/pricing", title: "Pricing" },
      { type: "text_result", domain: "example.com", url: "https://example.com/blog", title: "Blog" },
    ],
  },
};
const OPENED = {
  type: "item.completed",
  item: { type: "web_search", action: { type: "open_page", url: "https://example.com/docs" }, results: [] },
};
const ANSWER = {
  type: "item.completed",
  item: {
    type: "agent_message",
    text: JSON.stringify({ facts: [{ claim: "Costs $20.", source: "https://example.com/pricing" }] }),
  },
};
const COMPLETED = { type: "turn.completed", usage: { input_tokens: 27_725, cached_input_tokens: 9_984, output_tokens: 192 } };
const STDOUT = events(STARTED, NARRATION, SEARCH, OPENED, ANSWER, COMPLETED);

const budget = (script = {}) => {
  const calls = [];
  const answers = {
    reserve: { httpStatus: 200, body: { status: "ok", callId: "call1" } },
    dispatch: { httpStatus: 200, body: { status: "ok", firstConsumption: true } },
    settle: { httpStatus: 200, body: { status: "ok", state: "settled" } },
    unknown: { httpStatus: 200, body: { status: "ok" } },
    ...script,
  };
  return {
    calls,
    port: async (action, fields) => {
      calls.push({ action, fields });
      return answers[action];
    },
  };
};
const noApi = async () => {
  throw new Error("the subscription channel must not call the API");
};

test("the arguments turn off every local tool and keep the user's config out", () => {
  const args = marketingCodexArguments({ model: "gpt-6.1-sol", allowedDomains: ["example.com"], schemaPath: "/tmp/s.json" });
  for (const feature of ["shell_tool", "unified_exec", "apps", "plugins", "multi_agent", "image_generation"]) {
    assert.ok(MARKETING_CODEX_DISABLED_FEATURES.includes(feature), feature);
    assert.ok(args.join(" ").includes(`--disable ${feature}`), feature);
  }
  for (const flag of ["--ignore-user-config", "--ignore-rules", "--ephemeral", "--json"]) assert.ok(args.includes(flag), flag);
  assert.equal(args[args.indexOf("--sandbox") + 1], "read-only");
  assert.equal(args[args.indexOf("--output-schema") + 1], "/tmp/s.json");
  assert.equal(args[args.indexOf("-m") + 1], "gpt-6.1-sol");
  assert.ok(args.includes('web_search="live"'));
  assert.ok(args.includes('tools.web_search.context_size="low"'));
  assert.ok(args.includes('tools.web_search.allowed_domains=["example.com"]'));
  assert.equal(args.at(-1), "-", "the prompt comes on stdin, never as an argument");
});

test("a text call has no web search and no schema unless it was given one", () => {
  const args = marketingCodexArguments({ model: "m", allowedDomains: null, schemaPath: null });
  assert.ok(args.includes('web_search="disabled"'));
  assert.equal(args.includes("--output-schema"), false);
  assert.equal(args.join(" ").includes("tools.web_search"), false);
});

test("an unfiltered search names no domains", () => {
  const args = marketingCodexArguments({ model: "m", allowedDomains: [], schemaPath: null });
  assert.ok(args.includes('web_search="live"'));
  assert.equal(args.join(" ").includes("allowed_domains"), false);
});

test("the prompt carries both roles, the search limit, and that a page's text is data", () => {
  const prompt = marketingCodexPrompt(
    [
      { role: "system", content: "SYSTEM" },
      { role: "user", content: "USER" },
    ],
    3,
  );
  assert.ok(prompt.indexOf("SYSTEM") < prompt.indexOf("at most 3"));
  assert.ok(prompt.indexOf("data") < prompt.indexOf("USER"));
  assert.doesNotMatch(marketingCodexPrompt([{ role: "user", content: "USER" }]), /at most/);
});

test("the events give the last message, its cited URLs, every retrieved page and the tokens", () => {
  const answer = readMarketingCodexEvents(STDOUT);
  assert.equal(answer.content, ANSWER.item.text);
  assert.deepEqual(answer.answerCitations, ["https://example.com/pricing"]);
  assert.deepEqual(answer.citations, ["https://example.com/pricing", "https://example.com/blog", "https://example.com/docs"]);
  assert.equal(answer.inputTokens, 27_725);
  assert.equal(answer.outputTokens, 192);
});

test("a link in the answer's text is cited without its markdown or punctuation", () => {
  const text = "See [the docs](https://example.com/docs), then https://example.com/a.";
  const answer = readMarketingCodexEvents(
    events({ type: "item.completed", item: { type: "agent_message", text } }, COMPLETED),
  );
  assert.deepEqual(answer.answerCitations, ["https://example.com/docs", "https://example.com/a"]);
});

test("a run that did not finish with an answer is no answer", () => {
  assert.equal(readMarketingCodexEvents(""), null);
  assert.equal(readMarketingCodexEvents("not json"), null);
  assert.equal(readMarketingCodexEvents(events(ANSWER)), null, "no turn.completed");
  assert.equal(readMarketingCodexEvents(events(COMPLETED)), null, "no message");
  assert.equal(readMarketingCodexEvents(events(ANSWER, COMPLETED, { type: "turn.failed", error: {} })), null);
  assert.equal(readMarketingCodexEvents(events({ type: "error", message: "refused" }, ANSWER, COMPLETED)), null);
  assert.equal(readMarketingCodexEvents(events(ANSWER, { type: "turn.completed", usage: {} })), null, "no tokens");
});

test("the child gets its login's variables and none of the worker's", async () => {
  let seen;
  const channel = marketingCodexChannel({
    bin: "/opt/codex",
    env: {
      HOME: "/home/tommy",
      PATH: "/usr/bin",
      MARKETING_GENERATOR_SUBMIT_SECRET: SECRET,
      MARKETING_APP_URL: "https://tomverse.app",
      MARKETING_LLM_API_KEY: "sk-fixture",
    },
    run: async (input) => {
      seen = { ...input, schemaOnDisk: JSON.parse(readFileSync(input.args[input.args.indexOf("--output-schema") + 1], "utf8")) };
      return STDOUT;
    },
  });
  const answer = await channel({
    model: "gpt-6.1-sol",
    messages: [{ role: "user", content: "Find it." }],
    webSearch: { allowedDomains: ["example.com"], answerSchema: { name: "a", schema: { type: "object" } } },
    maxWebSearchCalls: 3,
  });
  assert.deepEqual(seen.env, { HOME: "/home/tommy", PATH: "/usr/bin" });
  assert.equal(seen.bin, "/opt/codex");
  assert.deepEqual(seen.schemaOnDisk, { type: "object" });
  assert.match(seen.prompt, /Find it\./);
  assert.match(seen.prompt, /at most 3/);
  assert.ok(seen.args.includes('tools.web_search.allowed_domains=["example.com"]'));
  assert.equal(answer.inputTokens, 27_725);
  assert.equal(existsSync(seen.cwd), false, "its directory is removed");
});

test("a failed process is no answer, and its directory is still removed", async () => {
  let cwd;
  const channel = marketingCodexChannel({
    bin: "/opt/codex",
    env: {},
    run: async (input) => {
      cwd = input.cwd;
      return null;
    },
  });
  assert.equal(await channel({ model: "m", messages: [] }), null);
  assert.equal(existsSync(cwd), false);
});

test("the ledger settles a channel's answer at the pin's model and tier, with the tokens it reported", async () => {
  const ledger = budget();
  const outcome = await runMarketingLlmCall(
    {
      pin: PIN,
      generatorRunId: "run1",
      purpose: "market_intel",
      messages: [{ role: "user", content: "Find it." }],
      webSearch: { allowedDomains: ["example.com"] },
    },
    {
      budget: ledger.port,
      transport: noApi,
      apiKey: "",
      channel: async () => readMarketingCodexEvents(STDOUT),
    },
  );
  assert.equal(outcome.status, "answered");
  assert.deepEqual(outcome.answerCitations, ["https://example.com/pricing"]);
  assert.deepEqual(ledger.calls.map((call) => call.action), ["reserve", "dispatch", "settle"]);
  const settle = ledger.calls.at(-1).fields;
  assert.equal(settle.reportedModel, "gpt-6.1-sol");
  assert.equal(settle.reportedServiceTier, "default");
  assert.equal(settle.reportedInputTokens, 27_725);
  assert.equal(settle.reportedOutputTokens, 192);
});

test("a channel that returns nothing or throws is an unknown outcome, tried once", async () => {
  for (const channel of [async () => null, async () => { throw new Error("spawn failed"); }]) {
    const ledger = budget();
    let attempts = 0;
    const outcome = await runMarketingLlmCall(
      { pin: PIN, generatorRunId: "run1", purpose: "draft", messages: [] },
      {
        budget: ledger.port,
        transport: noApi,
        apiKey: "",
        channel: async () => {
          attempts += 1;
          return channel();
        },
      },
    );
    assert.equal(outcome.status, "unknown");
    assert.equal(attempts, 1);
    assert.deepEqual(ledger.calls.map((call) => call.action), ["reserve", "dispatch", "unknown"]);
  }
});

test("a refused reservation never starts the CLI", async () => {
  let attempts = 0;
  const outcome = await runMarketingLlmCall(
    { pin: PIN, generatorRunId: "run1", purpose: "draft", messages: [] },
    {
      budget: budget({ reserve: { httpStatus: 200, body: { status: "refused", code: "budget_exhausted" } } }).port,
      transport: noApi,
      apiKey: "",
      channel: async () => {
        attempts += 1;
        return null;
      },
    },
  );
  assert.equal(outcome.status, "refused");
  assert.equal(attempts, 0);
});

test("the channel is off unless the box selects it by its exact value", () => {
  assert.equal(marketingLlmChannelFromEnv({}), undefined);
  assert.equal(marketingLlmChannelFromEnv({ MARKETING_LLM_CHANNEL: "codex" }), undefined);
  assert.equal(
    typeof marketingLlmChannelFromEnv({ MARKETING_LLM_CHANNEL: "codex-subscription", MARKETING_CODEX_BIN: "/opt/codex" }),
    "function",
  );
});

test("the worker's configuration needs the CLI instead of the API key on the channel", () => {
  const env = {
    MARKETING_APP_URL: "https://tomverse.app",
    MARKETING_GENERATOR_SUBMIT_SECRET: SECRET,
    MARKETING_LLM_CHANNEL: "codex-subscription",
    MARKETING_CODEX_BIN: "/opt/codex",
  };
  const configured = marketingGeneratorWorkerConfig(env);
  assert.equal(configured.ok, true);
  assert.equal(configured.config.apiKey, "");
  assert.match(marketingGeneratorWorkerConfig({ ...env, MARKETING_CODEX_BIN: undefined }).reason, /MARKETING_CODEX_BIN/);
  // Without the channel, the API key is required as it always was.
  assert.match(
    marketingGeneratorWorkerConfig({ ...env, MARKETING_LLM_CHANNEL: undefined }).reason,
    /MARKETING_LLM_API_KEY/,
  );
});
