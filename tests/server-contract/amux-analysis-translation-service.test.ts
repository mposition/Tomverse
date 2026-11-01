import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

// The Korean reading aid on the analysis result: a paid call behind its own
// switch, under the provider's operational budget hold, cached by source.

const root = resolve(import.meta.dirname, "../..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;
const require = createRequire(import.meta.url);
const ai = require("ai") as Record<string, unknown>;
const { AVAILABLE_MODELS } = require(resolve(root, "lib/models.ts"));
let configured: string | null = "gpt-6-luna";
let held = true; let fail = false; let calls = 0; let holds = 0;
let output: (prompt: string) => unknown = (prompt) => ({
  items: (JSON.parse(prompt).items as Array<{ id: string }>).map(({ id }) => ({ id, ko: `한국어 ${id}` })) });
const settlements: number[] = [];
mock.module("ai", { namedExports: { ...ai, generateText: async (input: {
  maxRetries: number; system: string; prompt: string }) => {
  calls++; assert.equal(input.maxRetries, 0);
  assert.ok(input.system.includes("untrusted data"));
  if (fail) throw Error("unknown provider outcome");
  return { output: output(input.prompt), usage: { inputTokens: 30, outputTokens: 10 } };
} } });
mock.module(mod("lib/autoLlmRouterSettings.ts"), { namedExports: { readAutoLlmRouterModelId: async () => configured } });
mock.module(mod("lib/autoLlmRouter.ts"), { namedExports: {
  reserveRouterCost: async (_provider: string, cost: number) => { holds++; assert.ok(cost > 0); return held; },
  settleRouterCost: async (_provider: string, delta: number) => { settlements.push(delta); },
} });
mock.module(mod("lib/modelRegistry.ts"), { namedExports: { getRuntimeModels: async () => AVAILABLE_MODELS } });
mock.module(mod("lib/modelPricing.ts"), { namedExports: {
  resolveModelPricing: () => ({ inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 2 }) } });
mock.module(mod("lib/activeAiModel.ts"), { namedExports: { getActiveAiModel: () => ({}) } });
const load = () => import(mod("lib/amux/ideaAnalysisTranslation.ts"));
const items = [{ id: "covered", text: "Covers `lib/a.ts`." }, { id: "u:c1:title", text: "Add toggle" }];
const reset = async () => {
  process.env.TOMVERSE_AMUX_ADMIN_KO_TRANSLATION = "enabled";
  configured = "gpt-6-luna"; held = true; fail = false; calls = 0; holds = 0; settlements.length = 0;
  output = (prompt) => ({ items: (JSON.parse(prompt).items as Array<{ id: string }>)
    .map(({ id }) => ({ id, ko: `한국어 ${id}` })) });
  (await load()).clearAmuxTranslationCache();
};

test("no call and no hold unless the switch is exactly enabled", async () => {
  for (const value of [undefined, "true", "on", "Enabled"]) {
    await reset();
    if (value === undefined) delete process.env.TOMVERSE_AMUX_ADMIN_KO_TRANSLATION;
    else process.env.TOMVERSE_AMUX_ADMIN_KO_TRANSLATION = value;
    assert.deepEqual(await (await load()).translateAmuxItemsToKorean(items), { state: "disabled" });
    assert.equal(calls, 0); assert.equal(holds, 0);
  }
});

test("no router model, a refused budget or an over-long page makes no provider call", async () => {
  const { translateAmuxItemsToKorean } = await load();
  for (const id of [null, "unavailable-model"]) {
    await reset(); configured = id;
    assert.deepEqual(await translateAmuxItemsToKorean(items), { state: "unavailable" });
    assert.equal(calls, 0); assert.equal(holds, 0);
  }
  await reset(); held = false;
  assert.deepEqual(await translateAmuxItemsToKorean(items), { state: "unavailable" });
  assert.equal(calls, 0); assert.equal(holds, 1);
  await reset();
  assert.deepEqual(await translateAmuxItemsToKorean([{ id: "a", text: "x".repeat(24_001) }]),
    { state: "too_large" });
  assert.deepEqual(await translateAmuxItemsToKorean([]), { state: "empty" });
  assert.equal(calls, 0); assert.equal(holds, 0);
});

test("a validated translation settles actual usage and the same source is then answered from memory", async () => {
  await reset();
  const { translateAmuxItemsToKorean } = await load();
  const first = await translateAmuxItemsToKorean(items);
  assert.deepEqual(first, { state: "translated", cached: false,
    translations: { covered: "한국어 covered", "u:c1:title": "한국어 u:c1:title" } });
  assert.equal(calls, 1); assert.equal(holds, 1);
  assert.equal(settlements.length, 1); assert.ok(settlements[0] < 0);
  const second = await translateAmuxItemsToKorean(items.map((item) => ({ ...item })));
  assert.equal(second.state, "translated");
  assert.equal(second.state === "translated" && second.cached, true);
  assert.equal(calls, 1); assert.equal(holds, 1);
  await translateAmuxItemsToKorean([{ ...items[0], text: "Covers more." }, items[1]]);
  assert.equal(calls, 2);
});

test("a malformed answer is not kept, and an unknown outcome keeps its hold", async () => {
  await reset();
  const { translateAmuxItemsToKorean } = await load();
  output = () => ({ items: [{ id: "covered", ko: "하나" }] });
  assert.deepEqual(await translateAmuxItemsToKorean(items), { state: "unavailable" });
  assert.equal(settlements.length, 1);
  output = (prompt) => ({ items: (JSON.parse(prompt).items as Array<{ id: string }>)
    .map(({ id }) => ({ id, ko: "번역" })) });
  assert.equal((await translateAmuxItemsToKorean(items)).state, "translated");
  assert.equal(calls, 2);
  await reset(); fail = true;
  assert.deepEqual(await translateAmuxItemsToKorean(items), { state: "unavailable" });
  assert.equal(calls, 1); assert.equal(holds, 1); assert.equal(settlements.length, 0);
});
