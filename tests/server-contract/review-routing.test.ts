import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..", "..");
const mod = (file: string) => pathToFileURL(resolve(root, file)).href;
const require = createRequire(import.meta.url);
process.env.E2E_DISABLE_DATABASE = "true";
process.env.NEXTAUTH_URL = "http://127.0.0.1:3100";
process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:1/test";
const { AVAILABLE_MODELS } = require(resolve(root, "lib/models.ts"));
let configured: string | null = "gpt-6-luna";
let guidance = "Shared Chat routing criteria, revision one.";
let budget = true;
let failed = false;
let usage: { inputTokens?: number; outputTokens?: number } = { inputTokens: 100, outputTokens: 10 };
const calls: Array<{ system: string; maxRetries: number }> = [];
const holds: number[] = [];
const settlements: number[] = [];
let installed = false;

async function load() {
  if (!installed) {
    installed = true;
    const realAi = require("ai");
    mock.module("ai", { namedExports: { ...realAi, generateText: async (options: { system: string; maxRetries: number }) => {
      calls.push(options);
      if (failed) throw new Error("unknown provider outcome");
      return { output: { kind: "text", preset: "standard", choices: [{ provider: "openai", modelId: "gpt-6-luna" }] }, usage };
    } } });
    mock.module(mod("lib/autoLlmRouterSettings.ts"), { namedExports: { readAutoLlmRouterModelId: async () => configured } });
    mock.module(mod("lib/autoLlmRouterGuidance.ts"), { namedExports: { readActiveRouterGuidance: async () => ({ guidance, cycleId: "shared-cycle" }) } });
    mock.module(mod("lib/autoLlmRouter.ts"), { namedExports: {
      reserveRouterCost: async (_provider: string, amount: number) => { holds.push(amount); return budget; },
      settleRouterCost: async (_provider: string, difference: number) => { settlements.push(difference); },
    } });
    mock.module(mod("lib/activeAiModel.ts"), { namedExports: { getActiveAiModel: () => ({}) } });
  }
  return import(mod("lib/reviewRouting.ts"));
}
const { reviewRoutingCandidates } = require(resolve(root, "lib/reviewRoutingCore.ts"));
const { buildAutoLlmRouterSystem, CHAT_RESEARCH_ROUTING_CRITERIA } = require(resolve(root, "lib/autoLlmRouterCore.ts"));
const input = { text: "Explain this code", context: "", providers: ["openai"], models: AVAILABLE_MODELS,
  candidates: reviewRoutingCandidates({ providers: ["openai"], models: AVAILABLE_MODELS, imageModels: [], plan: "Max", hasImages: false }) };
function reset() { process.env.REVIEW_EASY_ENABLED = "true"; configured = "gpt-6-luna"; budget = true; failed = false; usage = { inputTokens: 100, outputTokens: 10 }; calls.length = holds.length = settlements.length = 0; }

test("Review routing remains off until explicitly enabled and never calls without a configured router", async () => {
  const { routeReviewPrompt } = await load(); reset();
  delete process.env.REVIEW_EASY_ENABLED;
  assert.equal(await routeReviewPrompt(input), null);
  process.env.REVIEW_EASY_ENABLED = "true"; configured = null;
  assert.equal(await routeReviewPrompt(input), null);
  assert.equal(calls.length, 0); assert.equal(holds.length, 0);
});
test("the existing provider budget hold is required before any Review routing call", async () => {
  const { routeReviewPrompt } = await load(); reset(); budget = false;
  assert.equal(await routeReviewPrompt(input), null);
  assert.equal(calls.length, 0); assert.ok(holds[0] > 0);
});
test("Review reads the same live Chat guidance on each prompt and settles reported usage", async () => {
  const { routeReviewPrompt } = await load(); reset(); guidance = "Shared Chat routing criteria, revision one.";
  assert.equal((await routeReviewPrompt(input))?.choices[0].modelId, "gpt-6-luna");
  guidance = "Shared Chat routing criteria, revision two.";
  await routeReviewPrompt(input);
  assert.match(calls[0].system, /revision one/); assert.match(calls[1].system, /revision two/);
  assert.ok(calls[0].system.includes(CHAT_RESEARCH_ROUTING_CRITERIA));
  assert.ok(buildAutoLlmRouterSystem(guidance).includes(CHAT_RESEARCH_ROUTING_CRITERIA));
  assert.equal(calls[0].maxRetries, 0); assert.equal(settlements.length, 2);
  assert.ok(holds.every(amount => amount > 0));
});
test("unknown outcomes and missing usage retain their reservation without retries", async () => {
  const { routeReviewPrompt } = await load(); reset(); failed = true;
  assert.equal(await routeReviewPrompt(input), null);
  assert.equal(calls.length, 1); assert.equal(settlements.length, 0);
  reset(); usage = {};
  assert.ok(await routeReviewPrompt(input));
  assert.equal(calls.length, 1); assert.equal(settlements.length, 0);
});
