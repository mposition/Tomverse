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
let readRewriteSwitch = async () => false;
let readGuidance: (db?: unknown, kind?: string) => Promise<{ guidance: string; cycleId: string | null }> =
  async () => ({ guidance: "", cycleId: null });
const holds: number[] = [];
let budgetAllowed = true;
let routerFailure: unknown = null;
let outputFailure: unknown = null;
let waitForAbort = false;
let routerOutput: { reason: string; topic: string; modelId: string; requiresFileGeneration?: boolean } = {
  reason: "short question", topic: "cats", modelId: "deepseek-v4-flash",
};

const prismaMock = {
  appSetting: { findUnique: async () => null },
  autoRouterDecision: {
    findMany: async (): Promise<Array<{ sessionTopic: string; pickedModelId: string; taskKind: string }>> => [],
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
          if (waitForAbort) {
            await new Promise((resolve) => setTimeout(resolve, 15));
            throw new DOMException('private request', 'AbortError');
          }
          if (routerFailure) throw routerFailure;
          return generateRouterResult ? generateRouterResult() : {
            get output() {
              if (outputFailure) throw outputFailure;
              return routerOutput;
            },
            usage: { inputTokens: 100, outputTokens: 20 },
          };
        },
      },
    });
    mock.module(mod("lib/prisma.ts"), { namedExports: { prisma: prismaMock } });
    mock.module(mod("lib/autoLlmRouterSettings.ts"), {
      namedExports: {
        readAutoLlmRouterModelId: async () => "gpt-6-luna",
        readAutoLlmRouterRewrite: () => readRewriteSwitch(),
      },
    });
    mock.module(mod("lib/autoLlmRouterGuidance.ts"), {
      namedExports: {
        readActiveRouterGuidance: (db?: unknown, kind?: string) => readGuidance(db, kind),
      },
    });
    mock.module(mod("lib/chatSecurity.ts"), {
      namedExports: { holdChatUsageBucket: async (...args: unknown[]) => {
        holds.push(args[5] as number);
        return budgetAllowed;
      } },
    });
    mock.module(mod("lib/activeAiModel.ts"), {
      namedExports: { getActiveAiModel: (model: { id: string }) => ({ modelId: model.id }) },
    });
  }
  return import(mod("lib/autoLlmRouter.ts"));
}

const pick = async (recordDecision?: Promise<boolean>, canPersist = false, extra: Record<string, unknown> = {}) => {
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
    ...extra,
  });
  // The row write is not awaited by the turn.
  await new Promise((resolve) => setTimeout(resolve, 20));
  return result;
};

test("combined routing returns both decisions in one reserved call and preserves image record gating", async () => {
  const context = {
    modelId: "gpt-6-luna",
    candidates: [{ id: "gpt-image-2", name: "Image", latency: "fast", credits: { standard: 8 } }],
    previousImagePrompt: null, attachedPhoto: false, prompt: "Message: Draw a cat",
    maxOutputTokens: 400, timeoutMs: 8000,
  };
  const image = { image: true, modelId: "gpt-image-2", preset: "standard", prompt: "", edit: false };
  const original = generateRouterResult;
  generateRouterResult = () => ({ output: { ...routerOutput, imageIntent: image }, usage: { inputTokens: 200, outputTokens: 60 } });
  try {
    created.length = 0;
    routerRequests.length = 0;
    holds.length = 0;
    let decision: { image: boolean } | undefined;
    const result = await pick(undefined, false, {
      imageIntent: Promise.resolve(context),
      onImageDecision: (value: { image: boolean }) => { decision = value; },
      recordDecision: async () => !decision?.image,
    });
    assert.equal(result?.modelId, routerOutput.modelId);
    assert.equal(decision?.image, true);
    assert.equal(routerRequests.length, 1);
    assert.equal(routerRequests[0].maxOutputTokens, 600);
    const { autoLlmRouterWorstCaseMicroUsd } = require(resolve(ROOT, "lib/autoLlmRouterCore.ts"));
    const { resolveModelPricing } = require(resolve(ROOT, "lib/modelPricing.ts"));
    const { AVAILABLE_MODELS } = require(resolve(ROOT, "lib/models.ts"));
    const prices = resolveModelPricing(AVAILABLE_MODELS.find((model: { id: string }) => model.id === "gpt-6-luna"));
    const expectedHold = autoLlmRouterWorstCaseMicroUsd({
      ...routerRequests[0],
      inputUsdPerMillionTokens: prices.inputUsdPerMillionTokens,
      outputUsdPerMillionTokens: prices.outputUsdPerMillionTokens,
    });
    assert.deepEqual(holds, [expectedHold, expectedHold], "day and month reserve the exact combined request bound");
    assert.match(String(routerRequests[0].system), /imageIntent/);
    assert.match(String(routerRequests[0].prompt), /Draw a cat/);
    assert.equal(created.length, 0);
  } finally { generateRouterResult = original; }
});

test("a refused combined budget never calls the provider or reports an image decision", async () => {
  budgetAllowed = false;
  routerRequests.length = 0;
  let accepted = false;
  try {
    assert.equal(await pick(undefined, false, {
      imageIntent: Promise.resolve({ modelId: "gpt-6-luna", candidates: [], previousImagePrompt: null, attachedPhoto: false, prompt: "test", maxOutputTokens: 400, timeoutMs: 8000 }),
      onImageDecision: () => { accepted = true; },
    }), null);
    assert.equal(routerRequests.length, 0);
    assert.equal(accepted, false);
  } finally { budgetAllowed = true; }
});

test("combined image output keeps edit and follow-up admission rules", async () => {
  const { callAutoLlmRouter } = await load();
  const { AVAILABLE_MODELS } = require(resolve(ROOT, "lib/models.ts"));
  const imageIntent = {
    modelId: "gpt-6-luna", candidates: [{ id: "gpt-image-2", name: "Image", latency: "fast", credits: { standard: 8 } }],
    previousImagePrompt: null as string | null, attachedPhoto: false,
    prompt: "Message: Draw a cat", maxOutputTokens: 400, timeoutMs: 8000,
  };
  const base = {
    routerModel: AVAILABLE_MODELS.find((model: { id: string }) => model.id === "gpt-6-luna"),
    guidance: "", prompt: "Draw a cat", previousAnswer: null, session: null,
    candidates: [{ id: routerOutput.modelId }], imageIntent,
  };
  const original = generateRouterResult;
  try {
    for (const [attachedPhoto, previous, output, expected] of [
      [false, null, { image: false }, { image: false }],
      [false, null, { image: true, prompt: "unasked rewrite", edit: true }, { image: true, prompt: null, edit: false }],
      [true, null, { image: true, edit: false }, { image: false }],
      [true, null, { image: true, edit: true, prompt: "ignored" }, { image: true, prompt: null, edit: true }],
      [false, "a cat", { image: true, prompt: "a blue cat" }, { image: true, prompt: "a blue cat", edit: false }],
      [false, "a cat", { image: true, prompt: "x".repeat(1501) }, { image: false }],
    ] as const) {
      generateRouterResult = () => ({ output: { ...routerOutput, imageIntent: { modelId: "gpt-image-2", preset: "standard", ...output } } });
      const result = await callAutoLlmRouter({ ...base, imageIntent: { ...imageIntent, attachedPhoto, previousImagePrompt: previous } } as never);
      for (const [key, value] of Object.entries(expected)) assert.equal((result.imageDecision as Record<string, unknown>)[key], value);
    }
  } finally { generateRouterResult = original; }
});

test("combined routing does not claim an image decision after provider failure", async () => {
  routerFailure = new Error("failure");
  let accepted = false;
  try {
    assert.equal(await pick(undefined, false, {
      imageIntent: Promise.resolve({ modelId: "gpt-6-luna", candidates: [], previousImagePrompt: null, attachedPhoto: false, prompt: "test", maxOutputTokens: 400, timeoutMs: 8000 }),
      onImageDecision: () => { accepted = true; },
    }), null);
    assert.equal(accepted, false, "the caller must retain the standalone fallback");
  } finally { routerFailure = null; }
});

test("compact combined output distinguishes a chat decision from missing image output", async () => {
  const original = generateRouterResult;
  try {
    for (const [imageIntent, expected] of [[null, { image: false }], [undefined, undefined], [{}, undefined]] as const) {
      generateRouterResult = () => ({ output: { ...routerOutput, imageIntent } });
      let decision: unknown;
      await pick(undefined, true, {
        imageIntent: Promise.resolve({ modelId: "gpt-6-luna", candidates: [], previousImagePrompt: null,
          attachedPhoto: false, prompt: "test", maxOutputTokens: 400, timeoutMs: 8000 }),
        onImageDecision: (value: unknown) => { decision = value; },
      });
      assert.deepEqual(decision, expected);
    }
  } finally { generateRouterResult = original; }
});

test("combined routing shares only an identical message and retains conditional image context", async () => {
  const original = generateRouterResult;
  const { chatImageIntentUserMessage } = require(resolve(ROOT, "lib/chatImageIntentCore.ts"));
  const candidates = [{ id: "gpt-image-2", name: "Image", latency: "fast", credits: { standard: 8 } }];
  const message = "Summarize current Australian weather from official sources.";
  generateRouterResult = () => ({ output: { ...routerOutput, imageIntent: null } });
  try {
    for (const [imageMessage, previous, attachedPhoto] of [
      [message, null, false], ["bounded image message", null, false],
      [message, "a cat with a red hat", false], [message, null, true],
    ] as const) {
      routerRequests.length = 0;
      await pick(undefined, true, { prompt: message,
        imageIntent: Promise.resolve({ modelId: "gpt-6-luna", candidates, previousImagePrompt: previous,
          attachedPhoto, prompt: chatImageIntentUserMessage(imageMessage, candidates, previous, attachedPhoto),
          message: imageMessage, maxOutputTokens: previous ? 2500 : 400, timeoutMs: previous ? 12000 : 8000 }),
      });
      const request = routerRequests[0];
      const prompt = String(request.prompt);
      const system = String(request.system);
      assert.equal(prompt.split(message).length - 1, 1, "the routing message occurs only once");
      if (imageMessage !== message) assert.ok(prompt.includes(imageMessage), "a different bounded image message is retained");
      assert.ok(prompt.includes("standard 8"), "model prices and presets survive");
      assert.equal(system.includes("1500 characters"), previous !== null);
      assert.equal(system.includes("resize, move, remove"), attachedPhoto);
      if (previous) assert.ok(prompt.includes(previous));
      if (attachedPhoto) assert.ok(prompt.includes("Attached photo:"));
      assert.ok(system.includes("requiresFileGeneration=true"));
      assert.ok(system.includes("imageIntent=null"));
      const responseFormat = await (request.output as { responseFormat: Promise<{ schema: { properties: { imageIntent: { anyOf: unknown[] } } } }> }).responseFormat;
      assert.deepEqual(responseFormat.schema.properties.imageIntent.anyOf[1], { type: "null" });
    }
  } finally { generateRouterResult = original; }
});

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
  const { AUTO_LLM_ROUTER_TIMEOUT_MS, autoLlmRouterCandidates } = require(resolve(ROOT, "lib/autoLlmRouterCore.ts")) as typeof import("../../lib/autoLlmRouterCore.ts");
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
      assert.equal(result.outcome, "timeout");
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

test("provider and structured-output failures fall back and log content-free diagnostics", async () => {
  const secret = "private prompt, response and token";
  const log = mock.method(console, "info", () => {});
  try {
    for (const structured of [false, true]) {
      created.length = 0;
      const error = Object.assign(new Error(secret), structured
        ? { name: "AI_NoObjectGeneratedError", finishReason: "length", text: secret }
        : { name: "AI_APICallError", statusCode: 503, responseBody: secret });
      // An output getter can fail after generateText has resolved, too.
      routerFailure = structured ? null : error;
      outputFailure = structured ? error : null;
      assert.equal(await pick(), null);
      const row = created[0] as { outcome: string; reason: string | null };
      assert.equal(row.outcome, "error");
      assert.equal(row.reason, null);
      const entry = JSON.parse(log.mock.calls.at(-1)!.arguments[0] as string);
      assert.equal(entry.event, "chat_auto_llm_router");
      assert.equal(entry.traceId, "trace-1");
      assert.ok(entry.timeoutMs > 0);
      assert.equal(entry.failure.kind, structured ? "structured_output" : "provider");
      if (structured) {
        assert.equal(entry.failure.finishReason, "length");
        assert.equal(entry.failure.outputChars, secret.length);
      } else assert.equal(entry.failure.statusCode, 503);
      assert.ok(!JSON.stringify(entry).includes(secret));
    }
  } finally {
    routerFailure = null;
    outputFailure = null;
    log.mock.restore();
  }
});

test("a fired router deadline is recorded as a timeout even when the SDK throws AbortError", async () => {
  const { callAutoLlmRouter } = await load();
  const { AVAILABLE_MODELS } = require(resolve(ROOT, "lib/models.ts")) as {
    AVAILABLE_MODELS: Array<{ id: string }>;
  };
  waitForAbort = true;
  try {
    const result = await callAutoLlmRouter({
      routerModel: AVAILABLE_MODELS.find((model) => model.id === "gpt-6-luna"),
      guidance: "Choose a candidate.", prompt: "private request", previousAnswer: null,
      candidates: [], session: null, timeoutMs: 1,
    });
    assert.equal(result.outcome, "timeout");
    assert.equal(result.pick, null);
    assert.equal(result.usage, undefined);
    assert.deepEqual(result.failure, { kind: "timeout", error: "AbortError" });
  } finally { waitForAbort = false; }
});

test("an out-of-set model records invalid output and keeps the fallback", async () => {
  const original = routerOutput;
  const log = mock.method(console, "info", () => {});
  routerOutput = { ...original, modelId: "outside-candidate-set" };
  try {
    created.length = 0;
    assert.equal(await pick(), null);
    assert.equal((created[0] as { outcome: string }).outcome, "invalid");
    const entry = JSON.parse(log.mock.calls.at(-1)!.arguments[0] as string);
    assert.deepEqual(entry.failure, { kind: "invalid_output" });
    assert.equal(entry.pickedModelId, null);
  } finally {
    routerOutput = original;
    log.mock.restore();
  }
});

test("the live turn persists a timeout without claiming a pick or changing the fallback", async () => {
  const log = mock.method(console, "info", () => {});
  routerFailure = new DOMException("private request", "TimeoutError");
  try {
    created.length = 0;
    assert.equal(await pick(), null);
    const row = created[0] as { outcome: string; pickedModelId: string | null };
    assert.equal(row.outcome, "timeout");
    assert.equal(row.pickedModelId, null);
    const entry = JSON.parse(log.mock.calls.at(-1)!.arguments[0] as string);
    assert.equal(entry.outcome, "timeout");
    assert.equal(entry.failure.kind, "timeout");
  } finally {
    routerFailure = null;
    log.mock.restore();
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


test("router search preparation uses one priced call and malformed suggestions preserve the model pick", async () => {
  const original = generateRouterResult;
  try {
    for (const queries of [["one", "two"], ["one", "two", "three"], [42]]) {
      routerRequests.length = 0; holds.length = 0;
      generateRouterResult = () => ({ output: { ...routerOutput, requiresFileGeneration: false, searchQueries: queries, simpleLookup: queries.length === 2 ? true : "true" }, usage: { inputTokens: 100, outputTokens: 30 } });
      const result = await pick(undefined, false, { searchPlan: true });
      assert.equal(routerRequests.length, 1);
      assert.equal(routerRequests[0].maxOutputTokens, 440);
      assert.match(String(routerRequests[0].system), /searchQueries/);
      assert.equal(result?.requiresFileGeneration, false);
      assert.equal(result?.modelId, routerOutput.modelId);
      assert.equal(result?.simpleLookup, queries.length === 2);
      assert.deepEqual(result?.searchQueries, typeof queries[0] === "string" && queries.length <= 2 ? queries : []);
      const { autoLlmRouterWorstCaseMicroUsd } = require(resolve(ROOT, "lib/autoLlmRouterCore.ts"));
      const { resolveModelPricing } = require(resolve(ROOT, "lib/modelPricing.ts"));
      const { AVAILABLE_MODELS } = require(resolve(ROOT, "lib/models.ts"));
      const prices = resolveModelPricing(AVAILABLE_MODELS.find((model: { id: string }) => model.id === "gpt-6-luna"));
      const expected = autoLlmRouterWorstCaseMicroUsd({ ...routerRequests[0],
        inputUsdPerMillionTokens: prices.inputUsdPerMillionTokens, outputUsdPerMillionTokens: prices.outputUsdPerMillionTokens });
      assert.deepEqual(holds, [expected, expected]);
    }
    routerRequests.length = 0;
    const result = await pick();
    assert.equal(result?.searchQueries, undefined);
    assert.equal(routerRequests[0].maxOutputTokens, 200);
    assert.doesNotMatch(String(routerRequests[0].system), /searchQueries/);
  } finally { generateRouterResult = original; }
});


test("eligible rewrite guidance can finish during image preparation, with one priced dispatch after both", async t => {
  const oldSwitch = readRewriteSwitch, oldGuidance = readGuidance;
  t.after(() => { readRewriteSwitch = oldSwitch; readGuidance = oldGuidance; });
  const switchRead = Promise.withResolvers<void>();
  const image = Promise.withResolvers<null>();
  let rewriteReads = 0;
  readRewriteSwitch = async () => { switchRead.resolve(); return true; };
  readGuidance = async (_db, kind) => {
    if (kind === "rewrite") rewriteReads++;
    return { guidance: kind === "rewrite" ? "Keep both official mission names." : "", cycleId: null };
  };
  const callsBefore = routerRequests.length, holdsBefore = holds.length;
  const turn = pick(undefined, false, { prompt: "Compare both NASA missions.", rewriteAllowed: true, imageIntent: image.promise });
  try {
    await switchRead.promise;
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(rewriteReads, 1);
    assert.equal(routerRequests.length, callsBefore);
    assert.equal(holds.length, holdsBefore);
  } finally {
    image.resolve(null);
    await turn;
  }
  assert.equal(routerRequests.length, callsBefore + 1);
  assert.match(String(routerRequests.at(-1)?.system), /Keep both official mission names\./);
  assert.equal(holds.length, holdsBefore + 2);
});

test("held or long prompts do not wait on rewrite settings and an off switch skips rewrite guidance", async t => {
  const oldSwitch = readRewriteSwitch, oldGuidance = readGuidance;
  t.after(() => { readRewriteSwitch = oldSwitch; readGuidance = oldGuidance; });
  let switches = 0, guides = 0;
  readRewriteSwitch = async () => { switches++; return false; };
  readGuidance = async (_db, kind) => {
    if (kind === "rewrite") guides++;
    return { guidance: "", cycleId: null };
  };
  const callsBefore = routerRequests.length;
  await pick(undefined, false, { rewriteAllowed: false });
  await pick(undefined, false, { rewriteAllowed: true, prompt: "x".repeat(2000) });
  assert.equal(switches, 0);
  await pick(undefined, false, { rewriteAllowed: true });
  assert.equal(switches, 1);
  assert.equal(guides, 0);
  assert.equal(routerRequests.length, callsBefore + 3);
});

test("a context refusal precedes the live Router hold and provider; no eligible choice skips the check", async () => {
  const holdsBefore = holds.length;
  const callsBefore = routerRequests.length;
  let readCount = 0;
  const verifyPreparedContext = async () => { readCount++; return false; };
  assert.equal(await pick(undefined, false, { eligibleModelIds: ["deepseek-v4-flash"], verifyPreparedContext }), null);
  assert.equal(readCount, 0);
  assert.equal(await pick(undefined, false, { verifyPreparedContext }), null);
  assert.equal(readCount, 1);
  assert.equal(holds.length, holdsBefore);
  assert.equal(routerRequests.length, callsBefore);
});

test("fresh location prices the authored 8k and reuses its dated search decision across UTC midnight", async t => {
  const original = generateRouterResult;
  const text = "a".repeat(7_992) + "near me?overflow";
  const digest: string[] = [];
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-10T23:59:58Z") });
  const searchUtcDate = new Date().toISOString().slice(0, 10);
  const locationFusion = { authoredText: text, searchUtcDate, resume: null, onRouterDigest: (value: string) => { digest.push(value); } };
  try {
    generateRouterResult = () => ({ output: { ...routerOutput, requiresLocation: true }, usage: { inputTokens: 8, outputTokens: 2 } });
    holds.length = 0; routerRequests.length = 0;
    const chosen = await pick(undefined, true, { prompt: text, locationFusion, searchPlan: true });
    assert.equal(chosen?.requiresLocation, true);
    assert.equal(routerRequests.length, 1);
    assert.match(String(routerRequests[0].system), /CURRENT DEVICE LOCATION/);
    assert.match(String(routerRequests[0].system), /2026-11-10/);
    assert.match(String(routerRequests[0].prompt), /near me\?/);
    assert.ok(!String(routerRequests[0].prompt).includes("overflow"));
    const { autoLlmRouterWorstCaseMicroUsd } = require(resolve(ROOT, "lib/autoLlmRouterCore.ts"));
    const { resolveModelPricing } = require(resolve(ROOT, "lib/modelPricing.ts"));
    const { AVAILABLE_MODELS } = require(resolve(ROOT, "lib/models.ts"));
    const prices = resolveModelPricing(AVAILABLE_MODELS.find((model: { id: string }) => model.id === "gpt-6-luna"));
    const worst = autoLlmRouterWorstCaseMicroUsd({ ...routerRequests[0],
      inputUsdPerMillionTokens: prices.inputUsdPerMillionTokens, outputUsdPerMillionTokens: prices.outputUsdPerMillionTokens });
    assert.deepEqual(holds, [worst, worst]);
    t.mock.timers.setTime(Date.parse("2026-11-11T00:00:02Z"));
    const resumed = await pick(undefined, true, { prompt: text, searchPlan: true, locationFusion: {
      ...locationFusion, resume: { traceId: "first", routerDigest: digest[0], pick: chosen },
    } });
    assert.deepEqual(resumed, chosen);
    assert.deepEqual(digest, [digest[0], digest[0]]);
    assert.equal(routerRequests.length, 1);
    assert.equal(holds.length, 2);
  } finally { generateRouterResult = original; }
});

test("compact search menus preserve provider input values, use their own price and invalidate old continuations", async t => {
  const flag = "CHAT_ROUTER_COMPACT_SEARCH_MENU_ENABLED";
  const oldFlag = process.env[flag];
  t.after(() => { if (oldFlag === undefined) delete process.env[flag]; else process.env[flag] = oldFlag; });
  t.mock.method(prismaMock.autoRouterDecision, "findMany", async () => [
    { sessionTopic: "Voyager", pickedModelId: "deepseek-v4-flash", taskKind: "research" },
  ]);
  const { autoLlmRouterWorstCaseMicroUsd } = require(resolve(ROOT, "lib/autoLlmRouterCore.ts"));
  const { resolveModelPricing } = require(resolve(ROOT, "lib/modelPricing.ts"));
  const { AVAILABLE_MODELS } = require(resolve(ROOT, "lib/models.ts"));
  const prices = resolveModelPricing(AVAILABLE_MODELS.find((m: { id: string }) => m.id === "gpt-6-luna"));
  const input = {
    prompt: "Find the official NASA dates.",
    previousAnswer: "We compared Voyager 1 and Voyager 2.",
  };
  const digests: string[] = [];
  const locationFusion = { authoredText: input.prompt, searchUtcDate: "2026-11-12", resume: null,
    onRouterDigest: (digest: string) => digests.push(digest) };
  const run = async (compact: boolean, searchPlan: boolean) => {
    process.env[flag] = String(compact);
    const holdStart = holds.length, requestStart = routerRequests.length;
    const result = await pick(undefined, false, { ...input, locationFusion, searchPlan });
    assert.ok(result);
    assert.equal(routerRequests.length, requestStart + 1);
    const request = routerRequests[requestStart];
    const expected = autoLlmRouterWorstCaseMicroUsd({ ...request,
      inputUsdPerMillionTokens: prices.inputUsdPerMillionTokens, outputUsdPerMillionTokens: prices.outputUsdPerMillionTokens });
    assert.ok(expected > 0);
    assert.deepEqual(holds.slice(holdStart), [expected, expected]);
    return { result, request, content: JSON.parse(String(request.prompt)),
      schema: await (request.output as { responseFormat: Promise<unknown> }).responseFormat };
  };
  const off = await run(false, true);
  const on = await run(true, true);
  const { columns, rows } = on.content.candidates as { columns: string[]; rows: unknown[][] };
  assert.deepEqual({ ...on.content, candidates: rows.map(row =>
    Object.fromEntries(columns.map((name, i) => [name, row[i]]))) }, off.content);
  assert.equal(off.content.message, input.prompt);
  assert.equal(off.content.previousAnswer, input.previousAnswer);
  assert.equal(off.content.session.topic, "Voyager");
  assert.deepEqual(on.result, off.result);
  assert.deepEqual(on.schema, off.schema);
  assert.deepEqual(on.request.model, { modelId: "gpt-6-luna" });
  for (const key of ["model", "system", "maxOutputTokens", "providerOptions"]) {
    assert.deepEqual(on.request[key], off.request[key], key);
  }
  assert.notEqual(digests[0], digests[1]);
  const requestsBeforeResume = routerRequests.length, holdsBeforeResume = holds.length;
  const resume = (digest: string) => pick(undefined, false, { ...input, searchPlan: true,
    locationFusion: { ...locationFusion, resume: { traceId: "prior", routerDigest: digest, pick: off.result } } });
  assert.equal(await resume(digests[0]), null);
  assert.deepEqual(await resume(digests[1]), on.result);
  assert.equal(routerRequests.length, requestsBeforeResume);
  assert.equal(holds.length, holdsBeforeResume);
  const plain = await run(false, false);
  const enabledPlain = await run(true, false);
  assert.ok(Array.isArray(plain.content.candidates));
  assert.equal(enabledPlain.request.prompt, plain.request.prompt);
  assert.deepEqual(enabledPlain.schema, plain.schema);
});

test("follow-up location and execution decisions share one request but keep their input texts distinct", async t => {
  const original = generateRouterResult;
  const log = t.mock.method(console, "info", () => {});
  const authored = "What is the forecast in Brisbane?";
  const previousAnswer = "I can check restaurants near your device.";
  try {
    generateRouterResult = () => ({ output: { ...routerOutput, requiresLocation: false }, usage: { inputTokens: 100, outputTokens: 20 } });
    routerRequests.length = 0;
    const result = await pick(undefined, true, {
      prompt: "Summarize the latest forecast.", previousAnswer,
      locationFusion: { scope: "existing", authoredText: authored, resume: null, searchUtcDate: "2026-11-11", onRouterDigest: () => {} },
    });
    assert.equal(routerRequests.length, 1);
    assert.equal(result?.requiresLocation, false);
    assert.ok(String(routerRequests[0].prompt).includes(JSON.stringify({ authoredMessage: authored })));
    assert.ok(String(routerRequests[0].prompt).includes(previousAnswer));
    const event = log.mock.calls.map(call => JSON.parse(String(call.arguments[0]))).find(entry => entry.event === "chat_auto_llm_router");
    assert.equal(event?.routerLocationScope, "existing");
    assert.ok(!JSON.stringify(event).includes(authored));
  } finally { generateRouterResult = original; }
});

test("the router's outcome reaches the caller, and a resumed location turn replays it instead of hiding a failure", async () => {
  // A failed call means the turn goes to the requested model, not the rule's
  // choice (applyLlmModelPick). A location consent resumes in a second request
  // that makes no call, so the outcome has to travel in the continuation.
  const log = mock.method(console, "info", () => {});
  const digest: string[] = [];
  const locationFusion = { authoredText: "near me?", searchUtcDate: "2026-11-13", resume: null,
    onRouterDigest: (value: string) => { digest.push(value); } };
  try {
    const outcomes: string[] = [];
    routerFailure = Object.assign(new Error("down"), { name: "AI_APICallError", statusCode: 503 });
    assert.equal(await pick(undefined, true, { prompt: "near me?", locationFusion,
      onCallOutcome: (outcome: string) => outcomes.push(outcome) }), null);
    routerFailure = null;
    assert.deepEqual(outcomes, ["error"]);
    const calls = routerRequests.length;

    const resumed: string[] = [];
    assert.equal(await pick(undefined, true, { prompt: "near me?", onCallOutcome: (outcome: string) => resumed.push(outcome),
      locationFusion: { ...locationFusion, resume: { traceId: "first", routerDigest: digest[0], pick: null, routerOutcome: "error" } } }), null);
    assert.deepEqual(resumed, ["error"]);
    assert.equal(routerRequests.length, calls, "a resume makes no second call");

    // A continuation sealed before the field existed resumes as a turn the router never saw.
    const legacy: string[] = [];
    await pick(undefined, true, { prompt: "near me?", onCallOutcome: (outcome: string) => legacy.push(outcome),
      locationFusion: { ...locationFusion, resume: { traceId: "first", routerDigest: digest[0], pick: null } } });
    assert.deepEqual(legacy, []);
  } finally { routerFailure = null; log.mock.restore(); }
});
