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
        generateText: async () => ({
          output: { reason: "short question", topic: "cats", modelId: "deepseek-v4-flash" },
          usage: { inputTokens: 100, outputTokens: 20 },
        }),
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

const pick = async (recordDecision?: Promise<boolean>) => {
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
