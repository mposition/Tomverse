// Contract: the Auto router keeps a decision row only for a turn a chat model
// answers. When /api/chat finds the turn is an image request, the row the
// router call would have written is not written -- routing data, optimizer
// samples and session memory hold chat turns only.

import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(ROOT, path)).href;
const require = createRequire(import.meta.url);

process.env.E2E_DISABLE_DATABASE = "true";
process.env.NEXTAUTH_URL ||= "http://127.0.0.1:3100";
process.env.DATABASE_URL ||=
  "postgresql://e2e:e2e@127.0.0.1:1/e2e?connect_timeout=1";

const created: unknown[] = [];
let mocksInstalled = false;
let routerOutput: { reason: string; topic: string; modelId: string; requiresFileGeneration?: boolean } = {
  reason: "short question", topic: "cats", modelId: "deepseek-v4-flash",
};
let routerFailure: unknown = null;
let outputFailure: unknown = null;
let waitForAbort = false;

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
    fn({ $executeRaw: async () => 0 }),
};

async function load() {
  if (!mocksInstalled) {
    mocksInstalled = true;
    const realAi = require("ai") as Record<string, unknown>;
    mock.module("ai", {
      namedExports: {
        ...realAi,
        generateText: async () => {
          if (waitForAbort) {
            await new Promise((resolve) => setTimeout(resolve, 15));
            throw new DOMException("private request", "AbortError");
          }
          if (routerFailure) throw routerFailure;
          return {
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
