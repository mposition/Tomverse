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
let mockHeld: (() => boolean) | null = null;
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
  reserveRouterCost: async (_provider: string, cost: number) => {
    holds++; assert.ok(cost > 0); return mockHeld ? mockHeld() : held; },
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
  mockHeld = null;
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
    assert.deepEqual(await translateAmuxItemsToKorean(items), { state: "unavailable", calls: 0 });
    assert.equal(calls, 0); assert.equal(holds, 0);
  }
  await reset(); held = false;
  assert.deepEqual(await translateAmuxItemsToKorean(items), { state: "unavailable", calls: 0 });
  assert.equal(calls, 0); assert.equal(holds, 1);
  await reset();
  assert.deepEqual(await translateAmuxItemsToKorean([]), { state: "empty" });
  assert.equal(calls, 0); assert.equal(holds, 0);
});

test("a page larger than one call is translated in calls of one call's size, each held and settled", async () => {
  await reset();
  const { translateAmuxItemsToKorean } = await load();
  // Three items of 10,000 characters: two calls (24,000 a call), plus one item of
  // 30,000 characters cut at a line break into two pieces.
  const brief = `${"a".repeat(15_000)}\n${"b".repeat(15_000)}`;
  const page = [{ id: "x", text: "x".repeat(10_000) }, { id: "y", text: "y".repeat(10_000) },
    { id: "z", text: "z".repeat(10_000) }, { id: "u:c1:brief", text: brief }];
  const sentIds: string[][] = [];
  output = (prompt) => {
    const asked = JSON.parse(prompt).items as Array<{ id: string; text: string }>;
    sentIds.push(asked.map(({ id }) => id));
    assert.ok(asked.reduce((total, item) => total + item.text.length, 0) <= 24_000, "each call stays one call's size");
    return { items: asked.map(({ id, text }) => ({ id, ko: `K${text.slice(0, 1)}` })) };
  };
  const done = await translateAmuxItemsToKorean(page);
  assert.equal(done.state, "translated");
  assert.ok(done.state === "translated" && done.calls === calls && calls >= 3);
  assert.equal(holds, calls, "every call holds its own worst case");
  assert.equal(settlements.length, calls, "and settles its own usage");
  assert.deepEqual(sentIds.flat().filter((id) => id.startsWith("u:c1:brief#")), ["u:c1:brief#0", "u:c1:brief#1"]);
  assert.deepEqual(done.state === "translated" && done.translations,
    { x: "Kx", y: "Ky", z: "Kz", "u:c1:brief": "Ka\nKb" });
  // A refused hold on a later call ends the request; the calls already made stay cached.
  const before = calls;
  await (await load()).clearAmuxTranslationCache();
  let left = 1; held = true;
  mockHeld = () => left-- > 0;
  const partial = await translateAmuxItemsToKorean(page);
  assert.deepEqual(partial, { state: "unavailable", calls: 1 });
  assert.equal(calls, before + 1);
  mockHeld = null;
  const again = await translateAmuxItemsToKorean(page);
  assert.equal(again.state, "translated");
  assert.equal(again.state === "translated" && again.calls, calls - before - 1, "only the calls not yet made are paid");
});

test("a validated translation settles actual usage and the same source is then answered from memory", async () => {
  await reset();
  const { translateAmuxItemsToKorean } = await load();
  const first = await translateAmuxItemsToKorean(items);
  assert.deepEqual(first, { state: "translated", cached: false, calls: 1,
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
  assert.deepEqual(await translateAmuxItemsToKorean(items), { state: "unavailable", calls: 1 });
  assert.equal(settlements.length, 1);
  output = (prompt) => ({ items: (JSON.parse(prompt).items as Array<{ id: string }>)
    .map(({ id }) => ({ id, ko: "번역" })) });
  assert.equal((await translateAmuxItemsToKorean(items)).state, "translated");
  assert.equal(calls, 2);
  await reset(); fail = true;
  assert.deepEqual(await translateAmuxItemsToKorean(items), { state: "unavailable", calls: 1 });
  assert.equal(calls, 1); assert.equal(holds, 1); assert.equal(settlements.length, 0);
});
