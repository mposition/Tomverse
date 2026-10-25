import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
const root = resolve(import.meta.dirname, "../..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;
const require = createRequire(import.meta.url);
const ai = require("ai") as Record<string, unknown>;
const { AVAILABLE_MODELS } = require(resolve(root, "lib/models.ts"));
let configured: string | null = "gpt-6-luna";
let held = true; let fail = false; let calls = 0; let holds = 0;
let output: unknown = { requiresLocation: true };
const settlements: number[] = [];
mock.module("ai", { namedExports: { ...ai, generateText: async (input: { maxRetries: number; maxOutputTokens: number; prompt: string }) => {
  calls++; assert.equal(input.maxRetries, 0); assert.equal(input.maxOutputTokens, 400);
  assert.equal(JSON.parse(input.prompt).userMessage, "지금 제가 있는 위치가 어디인가요?");
  if (fail) throw Error("unknown provider outcome");
  return { output, usage: { inputTokens: 30, outputTokens: 10 } };
} } });
mock.module(mod("lib/autoLlmRouterSettings.ts"), { namedExports: { readAutoLlmRouterModelId: async () => configured } });
mock.module(mod("lib/autoLlmRouter.ts"), { namedExports: {
  reserveRouterCost: async (_provider: string, cost: number) => { holds++; assert.ok(cost > 0); return held; },
  settleRouterCost: async (_provider: string, delta: number) => { settlements.push(delta); },
} });
mock.module(mod("lib/modelRegistry.ts"), { namedExports: { getRuntimeModels: async () => AVAILABLE_MODELS } });
mock.module(mod("lib/modelPricing.ts"), { namedExports: { resolveModelPricing: () => ({ inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 2 }) } });
mock.module(mod("lib/activeAiModel.ts"), { namedExports: { getActiveAiModel: () => ({}) } });
const load = () => import(mod("lib/chatLocationIntent.ts"));
const ask = async () => (await load()).detectChatLocationIntent("지금 제가 있는 위치가 어디인가요?");
const reset = () => { configured = "gpt-6-luna"; held = true; fail = false; calls = 0; holds = 0; settlements.length = 0; output = { requiresLocation: true }; };

test("location analysis cannot call a provider when routing is disabled, unavailable or its budget refuses", async () => {
  for (const id of [null, "unavailable-model"]) {
    reset(); configured = id; assert.equal(await ask(), false); assert.equal(calls, 0); assert.equal(holds, 0);
  }
  reset(); held = false; assert.equal(await ask(), false); assert.equal(calls, 0); assert.equal(holds, 1);
});
test("only a validated semantic decision can request permission, with actual usage settled", async () => {
  for (const value of [{ requiresLocation: true }, { requiresLocation: false }, { requiresLocation: "true" }, { requiresLocation: true, latitude: 1 }]) {
    reset(); output = value;
    assert.equal(await ask(), typeof value.requiresLocation === "boolean" && Object.keys(value).length === 1 && value.requiresLocation);
    assert.equal(calls, 1); assert.equal(settlements.length, 1); assert.ok(settlements[0] < 0);
  }
});
test("unknown model outcomes keep their hold and fall back without granting permission", async () => {
  reset(); fail = true; assert.equal(await ask(), false); assert.equal(calls, 1); assert.equal(holds, 1); assert.equal(settlements.length, 0);
});
