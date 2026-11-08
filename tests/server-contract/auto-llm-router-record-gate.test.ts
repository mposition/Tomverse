// Contract: the Auto router keeps a decision row only for a turn a chat model
// answers. When /api/chat finds the turn is an image request, the row the
// router call would have written is not written -- routing data, optimizer
// samples and session memory hold chat turns only.

import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { APICallError } from "ai";

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(ROOT, path)).href;
const require = createRequire(import.meta.url);

process.env.E2E_DISABLE_DATABASE = "true";
process.env.NEXTAUTH_URL ||= "http://127.0.0.1:3100";
process.env.DATABASE_URL ||=
  "postgresql://e2e:e2e@127.0.0.1:1/e2e?connect_timeout=1";

const created: unknown[] = [];
const settlementWrites: unknown[][] = [];
let mocksInstalled = false;
let generateRouterResult: (() => unknown) | undefined;
const routerRequests: Record<string, unknown>[] = [];
let routerOutput: { reason: string; topic: string; modelId: string; requiresFileGeneration?: boolean } = {
  reason: "short question", topic: "cats", modelId: "deepseek-v4-flash",
};

const prismaMock = {
  appSetting: { findUnique: async () => null },
  autoRouterDecision: {
    findMany: async () => [],
    create: async ({ data }: { data: unknown }) => {
      created.push(data);
      return data;
    },
  },
  $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({ $executeRaw: async (...args: unknown[]) => {
      settlementWrites.push(args.slice(1));
      return 0;
    } }),
};

async function load() {
  if (!mocksInstalled) {
    mocksInstalled = true;
    const realAi = require("ai") as Record<string, unknown>;
    mock.module("ai", {
      namedExports: {
        ...realAi,
        generateText: async (options: Record<string, unknown>) => {
          routerRequests.push(options);
          return generateRouterResult ? generateRouterResult() : {
            output: routerOutput,
            usage: { inputTokens: 100, outputTokens: 20 },
          };
        },
      },
    });
    mock.module(mod("lib/prisma.ts"), { namedExports: { prisma: prismaMock } });
    mock.module(mod("lib/autoLlmRouterSettings.ts"), {
      namedExports: {
        readAutoLlmRouterModelId: async () => "gpt-6-luna",
        readAutoLlmRouterRewrite: async () => false,
      },
    });
    mock.module(mod("lib/autoLlmRouterGuidance.ts"), {
      namedExports: {
        readActiveRouterGuidance: async () => ({ guidance: "", cycleId: null }),
      },
    });
    mock.module(mod("lib/chatSecurity.ts"), {
      namedExports: { holdChatUsageBucket: async () => true },
    });
    mock.module(mod("lib/activeAiModel.ts"), {
      namedExports: { getActiveAiModel: () => ({}) },
    });
  }
  return import(mod("lib/autoLlmRouter.ts"));
}

const pick = async (recordDecision?: Promise<boolean>, canPersist = false) => {
  const { AVAILABLE_MODELS } = require(resolve(ROOT, "lib/models.ts")) as {
    AVAILABLE_MODELS: Array<{ id: string }>;
  };
  const { pickAutoModelWithLlm } = await load();
  const result = await pickAutoModelWithLlm({
    prompt: "고양이 그려줘",
    previousAnswer: null,
    eligibleModelIds: ["gpt-5-6-luna", "deepseek-v4-flash"],
    models: AVAILABLE_MODELS,
    creditsByModelId: { "gpt-5-6-luna": 8, "deepseek-v4-flash": 2 },
    ruleModelId: "gpt-5-6-luna",
    taskKind: "chat",
    userId: "user-1",
    conversationId: "conv-1",
    traceId: "trace-1",
    fileContext: { isAuthenticated: true, canPersist, webSearchRequested: false },
    ...(recordDecision ? { recordDecision } : {}),
  });
  // The row write is not awaited by the turn.
  await new Promise((resolve) => setTimeout(resolve, 20));
  return result;
};

test("a chat turn keeps its decision row", async () => {
  created.length = 0;
  const result = await pick();
  assert.equal(result?.modelId, "deepseek-v4-flash");
  assert.equal(created.length, 1);
  created.length = 0;
  await pick(Promise.resolve(true));
  assert.equal(created.length, 1);
});

test("an image turn's decision row is not written; the pick is still returned", async () => {
  created.length = 0;
  const result = await pick(Promise.resolve(false));
  assert.equal(result?.modelId, "deepseek-v4-flash");
  assert.equal(created.length, 0);
});

test("file routing records the raw model and reason without losing intent when capability is unavailable", async () => {
  const original = routerOutput;
  routerOutput = { ...original, reason: "Deliver a spreadsheet.", requiresFileGeneration: true };
  try {
    for (const canPersist of [true, false]) {
      created.length = 0;
      const result = await pick(Promise.resolve(true), canPersist);
      assert.equal(result?.requiresFileGeneration, true);
      assert.equal(result?.modelId, routerOutput.modelId);
      assert.equal(created.length, 1);
      const row = created[0] as { pickedModelId: string; reason: string; outcome: string };
      assert.equal(row.pickedModelId, routerOutput.modelId);
      assert.equal(row.reason, routerOutput.reason);
      assert.equal(row.outcome, "picked");
    }
  } finally { routerOutput = original; }
});

test("router failures preserve known usage and log content-free causes without retrying", async (t) => {
  const { callAutoLlmRouter } = await load();
  const { AVAILABLE_MODELS } = require(resolve(ROOT, "lib/models.ts")) as typeof import("../../lib/models.ts");
  const { autoLlmRouterCandidates, AUTO_LLM_ROUTER_TIMEOUT_MS } = require(resolve(ROOT, "lib/autoLlmRouterCore.ts")) as typeof import("../../lib/autoLlmRouterCore.ts");
  const { APICallError, JSONParseError, NoObjectGeneratedError, NoOutputGeneratedError, TypeValidationError } = require("ai") as typeof import("ai");
  const usage = { inputTokens: 100, outputTokens: 20 };
  const secret = "private-prompt-and-provider-secret";
  const response = { id: "response-1", timestamp: new Date(), modelId: "router" };
  const structuredError = (cause: Error, finishReason: "stop" | "length" = "stop") => new NoObjectGeneratedError({
    cause, message: secret, text: secret, response,
    usage: usage as ConstructorParameters<typeof NoObjectGeneratedError>[0]["usage"], finishReason,
  });
  const parseError = structuredError(new JSONParseError({ text: secret, cause: new Error(secret) }), "length");
  const schemaError = structuredError(new TypeValidationError({ value: secret, cause: new Error(secret) }));
  const input = {
    routerModel: AVAILABLE_MODELS.find(model => model.id === "gpt-6-luna")!,
    guidance: "Choose an eligible candidate.", prompt: secret, previousAnswer: null,
    candidates: autoLlmRouterCandidates(["gpt-5-6-luna", "deepseek-v4-flash"], AVAILABLE_MODELS, {}),
    session: null, traceId: "trace-call", cycleId: "cycle-call", decisionId: "decision-call", source: "routing_optimizer" as const,
  };
  const cases = [
    { name: "JSON parsing failure", result: () => { throw parseError; }, outcome: "invalid", failure: "output_parse", failureKind: "output_parse", usage, detail: { finishReason: "length", outputChars: secret.length } },
    { name: "schema validation failure", result: () => { throw schemaError; }, outcome: "invalid", failure: "output_schema", failureKind: "output_validation", usage },
    { name: "output getter failure", result: () => ({ usage, finishReason: "length", get output() { throw parseError; } }), outcome: "invalid", failure: "output_parse", failureKind: "output_parse", usage },
    { name: "empty output getter", result: () => ({ usage, finishReason: "stop", get output() { throw new NoOutputGeneratedError(); } }), outcome: "invalid", failure: "empty_output", failureKind: "output_missing", usage },
    { name: "ineligible model", result: () => ({ usage, finishReason: "stop", output: { modelId: secret } }), outcome: "invalid", failure: "invalid_pick", failureKind: "invalid_output", usage, detail: { modelIdPresent: true, modelIdEligible: false } },
    { name: "invalid file intent", result: () => ({ usage, output: { modelId: "gpt-5-6-luna", requiresFileGeneration: "yes" } }), outcome: "invalid", failure: "invalid_pick", failureKind: "invalid_output", usage, detail: { modelIdEligible: true, fileIntentType: "string" } },
    { name: "provider HTTP error", result: () => { throw new APICallError({ message: secret, url: `https://example.com/${secret}`, requestBodyValues: { prompt: secret }, responseBody: secret, statusCode: 429, isRetryable: true }); }, outcome: "error", failure: "provider_error", failureKind: "provider", usage: undefined, detail: { statusCode: 429, retryable: true } },
    { name: "unrecognized finish reason", result: () => ({ usage, finishReason: secret, output: { modelId: secret } }), outcome: "invalid", failure: "invalid_pick", failureKind: "invalid_output", usage, detail: { finishReason: undefined } },
    { name: "unknown failure", result: () => { throw new Error(secret); }, outcome: "error", failure: "call_error", failureKind: "unknown", usage: undefined },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const logs: string[] = [];
      const logger = mock.method(console, "warn", (line: string) => { logs.push(line); });
      generateRouterResult = scenario.result;
      routerRequests.length = 0;
      try {
        const result = await callAutoLlmRouter(input);
        assert.equal(result.outcome, scenario.outcome);
        assert.equal(result.pick, null);
        assert.deepEqual(result.usage, scenario.usage);
        assert.equal(routerRequests.length, 1);
        assert.equal(routerRequests[0].maxRetries, 0);
        assert.equal(logs.length, 1);
        assert.ok(!logs[0].includes(secret));
        const log = JSON.parse(logs[0]);
        assert.equal(log.event, "auto_llm_router_call_failed");
        assert.equal(log.failure, scenario.failure);
        assert.equal(log.failureKind, scenario.failureKind);
        assert.equal(log.outcome, scenario.outcome);
        assert.equal(log.source, "routing_optimizer");
        assert.equal(log.traceId, "trace-call");
        assert.equal(log.cycleId, "cycle-call");
        assert.equal(log.decisionId, "decision-call");
        assert.equal(log.timeoutMs, AUTO_LLM_ROUTER_TIMEOUT_MS);
        for (const [key, value] of Object.entries(scenario.detail ?? {})) assert.equal(log[key], value);
      } finally {
        generateRouterResult = undefined;
        logger.mock.restore();
      }
    });
  }
  await t.test("an expired call is identified from its actual abort signal", async () => {
    const logs: string[] = [];
    const logger = mock.method(console, "warn", (line: string) => { logs.push(line); });
    generateRouterResult = () => new Promise((_, reject) => {
      const signal = routerRequests.at(-1)!.abortSignal as AbortSignal;
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
    // AbortSignal.timeout is unref'ed; keep the test alive until it fires.
    const keepAlive = setTimeout(() => {}, 1_000);
    try {
      const result = await callAutoLlmRouter({ ...input, timeoutMs: 1 });
      assert.equal(result.outcome, "error");
      assert.equal(result.usage, undefined);
      assert.equal(JSON.parse(logs[0]).failure, "timeout");
      assert.equal(JSON.parse(logs[0]).failureKind, "timeout");
      assert.equal(JSON.parse(logs[0]).timeoutMs, 1);
    } finally {
      clearTimeout(keepAlive);
      generateRouterResult = undefined;
      logger.mock.restore();
    }
  });
  for (const knownUsage of [true, false]) {
    await t.test(knownUsage ? "invalid output settles reported usage in both provider periods" : "unknown usage retains the full provider hold", async () => {
      const logger = mock.method(console, "warn", () => {});
      created.length = 0;
      settlementWrites.length = 0;
      generateRouterResult = () => { throw knownUsage ? schemaError : new Error(secret); };
      try {
        assert.equal(await pick(), null);
        assert.equal(settlementWrites.length, knownUsage ? 2 : 0);
        const row = created[0] as { outcome: string; inputTokens: number | null; outputTokens: number | null };
        assert.equal(row.outcome, knownUsage ? "invalid" : "error");
        assert.equal(row.inputTokens, knownUsage ? 100 : null);
        assert.equal(row.outputTokens, knownUsage ? 20 : null);
        if (knownUsage) {
          assert.ok(Number(settlementWrites[0][0]) < 0, "only the unused reservation is returned");
          assert.equal(settlementWrites[0][0], settlementWrites[1][0]);
          assert.deepEqual(settlementWrites.map(values => values[2]), ["provider-cost-day", "provider-cost-month"]);
        }
      } finally {
        generateRouterResult = undefined;
        logger.mock.restore();
      }
    });
  }
});

test("a provider failure logs its category and trace while preserving the error fallback and decision row", async (t) => {
  const logs: string[] = [];
  const warning = mock.method(console, "warn", (value: string) => logs.push(value));
  t.after(() => warning.mock.restore());
  created.length = 0;
  const secret = "private response and credential";
  generateRouterResult = () => { throw new APICallError({
    message: secret, url: "https://example.invalid", statusCode: 503,
    requestBodyValues: { prompt: secret }, responseBody: secret,
  }); };
  try {
    assert.equal(await pick(), null);
    assert.equal((created[0] as { outcome: string }).outcome, "error");
    const failure = logs.map((line) => JSON.parse(line)).find((entry) => entry.event === "auto_llm_router_call_failed");
    assert.equal(failure.source, "live");
    assert.equal(failure.traceId, "trace-1");
    assert.equal(failure.routerModelId, "gpt-6-luna");
    assert.equal(failure.outcome, "error");
    assert.equal(failure.failureKind, "provider");
    assert.equal(failure.statusCode, 503);
    assert.ok(!logs.join("\n").includes(secret));
    assert.ok(!logs.join("\n").includes("고양이 그려줘"));
  } finally { generateRouterResult = undefined; }
});

test("an invalid pick logs separately from a provider failure and keeps its original outcome", async (t) => {
  const logs: string[] = [];
  const warning = mock.method(console, "warn", (value: string) => logs.push(value));
  t.after(() => warning.mock.restore());
  const original = routerOutput;
  created.length = 0;
  routerOutput = { ...original, modelId: "private invalid model response" };
  try {
    assert.equal(await pick(), null);
    assert.equal((created[0] as { outcome: string }).outcome, "invalid");
    const failure = JSON.parse(logs[0]);
    assert.equal(failure.outcome, "invalid");
    assert.equal(failure.failureKind, "invalid_output");
    assert.equal(failure.source, "live");
    assert.ok(!logs.join("\n").includes(routerOutput.modelId));
  } finally { routerOutput = original; }
});
