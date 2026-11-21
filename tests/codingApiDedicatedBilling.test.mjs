import assert from "node:assert/strict";
import test from "node:test";

import { createChatBudget } from "../lib/chatSecurity.ts";
import { codingApiDedicatedModel } from "../lib/codingCatalogChannels.ts";
import { codingRowRuntime, registryPricesFor } from "../lib/codingRowRuntime.ts";
import { codingCatalogRowSchema } from "../lib/modelCatalogCore.ts";
import { getModelUsageProfile, getWeightedUsageCredits } from "../lib/models.ts";

// A dedicated coding row on the coding API (owner decision 2026-11-21): it runs
// as its own published row and is charged at that row's prices and credit
// weight through the chat reservation, which records the snapshot it was
// priced from. One conversion with Code's managed path (lib/codingRowRuntime.ts).

const SNAPSHOT = { version: 12, contentHash: "a".repeat(64) };

const row = (overrides = {}) =>
  codingCatalogRowSchema.parse({
    modelId: "qwen3.7-coder-plus",
    source: "dedicated",
    channels: ["code", "api"],
    name: "Qwen 3.7 Coder Plus",
    provider: "qwen",
    apiModelId: "qwen3.7-coder-plus",
    minimumPlan: "Pro",
    capabilities: { toolCalling: "parallel", structuredOutput: "strict_schema", imageInput: false, maxContextTokens: 256_000, maxOutputTokens: 32_000 },
    pricing: { inputUsdPerMTok: 1, outputUsdPerMTok: 5, creditWeight: 9, verifiedAt: "2026-11-01", sources: ["https://www.alibabacloud.com/help/en/model-studio/model-pricing"] },
    terms: { allowsResaleAndCodingAgent: true, url: "https://www.alibabacloud.com/help/en/legal/terms", checkedAt: "2026-11-18" },
    retention: { url: "https://www.alibabacloud.com/help/en/legal/privacy", checkedAt: "2026-11-18" },
    processingRegion: "Singapore",
    ...overrides,
  });

test("a dedicated row runs as its own model: the row's credits, context, output limit and prices", () => {
  const built = codingRowRuntime(row(), SNAPSHOT);
  assert.equal(built.ok, true);
  const { model, pricing } = codingApiDedicatedModel(row(), built, SNAPSHOT);
  assert.equal(model.id, "qwen3.7-coder-plus");
  assert.equal(model.apiModel, "qwen3.7-coder-plus");
  assert.equal(model.provider, "qwen");
  assert.equal(getModelUsageProfile(model).credits, 9, "the row's credit weight, not a class default");
  assert.equal(model.contextWindowTokens, 256_000);
  assert.equal(model.maxOutputTokens, 32_000);
  assert.equal(model.inputUsdPerMillionTokens, 1);
  assert.equal(model.outputUsdPerMillionTokens, 5);
  assert.equal(model.cachedInputPriceMultiplier, 1, "an unverified cache discount is full price");
  assert.equal(model.minimumPlan, "Pro");
  assert.deepEqual(pricing, {
    cacheWriteUsdPerMillionTokens: null,
    pricingVersion: `coding_catalog_snapshot:12:${"a".repeat(64)}`,
    costSource: "coding_catalog_snapshot",
  });
});

test("a known provider model registered under another catalogue id is checked against the registry all the same", () => {
  // gpt-6-luna is in the price registry; the row calls it under its own id.
  const alias = (pricing = {}) =>
    row({ modelId: "luna-coder-alias", name: "Luna Coder", provider: "openai", apiModelId: "gpt-6-luna", pricing: { ...row().pricing, ...pricing } });
  const registry = registryPricesFor(alias(), { id: "luna-coder-alias", provider: "openai", apiModel: "gpt-6-luna", usageClass: "standard", maxOutputTokens: 32_000 });
  assert.ok(registry.length > 0, "found by provider and API model id, not by the row's id");
  const [known] = registry;
  assert.ok(known.inputUsdPerMillionTokens > 0 && known.outputUsdPerMillionTokens > 0);
  // Priced under what the registry says that model costs: refused, never reserved low and dispatched.
  assert.deepEqual(
    codingRowRuntime(alias({ inputUsdPerMTok: known.inputUsdPerMillionTokens / 2, outputUsdPerMTok: known.outputUsdPerMillionTokens }), SNAPSHOT),
    { ok: false, code: "CODE_CATALOG_PRICING_CHANGED" }
  );
  assert.deepEqual(
    codingRowRuntime(alias({ inputUsdPerMTok: known.inputUsdPerMillionTokens, outputUsdPerMTok: known.outputUsdPerMillionTokens / 2 }), SNAPSHOT),
    { ok: false, code: "CODE_CATALOG_PRICING_CHANGED" }
  );
  // Priced at or above it: runs, at the row's own prices, bounded by the registry's version.
  const atRegistry = codingRowRuntime(alias({ inputUsdPerMTok: known.inputUsdPerMillionTokens, outputUsdPerMTok: known.outputUsdPerMillionTokens }), SNAPSHOT);
  assert.equal(atRegistry.ok, true);
  assert.equal(atRegistry.price.inputUsdPerMillionTokens, known.inputUsdPerMillionTokens);
  assert.equal(atRegistry.price.cacheWriteBoundSource, known.pricingVersion);
  assert.equal(atRegistry.price.maxOutputTokens, Math.min(32_000, known.providerMaxOutputTokens ?? Infinity));
});

test("the registry's reasoning billing, output ceiling and price floor apply to any row calling that provider model", () => {
  const price = (overrides = {}) => ({
    inputUsdPerMillionTokens: 1,
    outputUsdPerMillionTokens: 5,
    reasoningTokenBilling: "billed_as_output",
    providerMaxOutputTokens: null,
    cacheWriteUsdPerMillionTokens: null,
    pricingVersion: "fixture-2026-11-21",
    ...overrides,
  });
  const run = (prices, overrides = {}) => codingRowRuntime(row(overrides), SNAPSHOT, { registryPrices: () => prices });
  assert.deepEqual(run([price({ reasoningTokenBilling: "billed_separately" })]), { ok: false, code: "CODE_REASONING_COST_UNBOUNDED" });
  assert.deepEqual(run([price({ outputUsdPerMillionTokens: 6 })]), { ok: false, code: "CODE_CATALOG_PRICING_CHANGED" });
  assert.deepEqual(run([price({ inputUsdPerMillionTokens: 1.5 })]), { ok: false, code: "CODE_CATALOG_PRICING_CHANGED" });
  // The provider's settable ceiling holds the row's output limit down.
  assert.equal(run([price({ providerMaxOutputTokens: 8_000 })]).price.maxOutputTokens, 8_000);
  assert.equal(run([price()]).price.maxOutputTokens, 32_000);
  // Two profiles of one provider model: the strictest of each.
  const both = run([
    price({ providerMaxOutputTokens: 16_000, cacheWriteUsdPerMillionTokens: 1.25 }),
    price({ providerMaxOutputTokens: 8_000, cacheWriteUsdPerMillionTokens: 2, pricingVersion: "fixture-thinking" }),
  ]);
  assert.equal(both.price.maxOutputTokens, 8_000);
  assert.equal(both.price.cacheWriteUsdPerMillionTokens, 2);
  assert.equal(both.price.cacheWriteBoundSource, "fixture-thinking");
  assert.deepEqual(run([price(), price({ reasoningTokenBilling: "billed_separately" })]), { ok: false, code: "CODE_REASONING_COST_UNBOUNDED" });
  assert.deepEqual(run([price(), price({ outputUsdPerMillionTokens: 9 })]), { ok: false, code: "CODE_CATALOG_PRICING_CHANGED" });
  // Unknown to the registry: the row's own values stand.
  const unknown = run([]);
  assert.equal(unknown.ok, true);
  assert.equal(unknown.price.cacheWriteUsdPerMillionTokens, undefined);
  assert.equal(unknown.price.cacheWriteBoundSource, "no_cache_write_requested");
  // Known with no write rate: null, bounded by that profile's version.
  assert.equal(run([price()]).price.cacheWriteUsdPerMillionTokens, null);
  assert.equal(run([price()]).price.cacheWriteBoundSource, "fixture-2026-11-21");
  // An Anthropic row's write bound is the larger of the registry's and 1.25x its own input.
  assert.equal(run([price({ cacheWriteUsdPerMillionTokens: 3 })], { provider: "anthropic" }).price.cacheWriteUsdPerMillionTokens, 3);
  assert.equal(run([], { provider: "anthropic" }).price.cacheWriteUsdPerMillionTokens, 1.25);
});

test("providers whose cost a token row cannot bound, and unknown providers, are refused", () => {
  for (const provider of ["openrouter", "deepinfra", "together", "sail", "perplexity"]) {
    assert.deepEqual(codingRowRuntime(row({ provider }), SNAPSHOT), { ok: false, code: "CODE_PROVIDER_COST_UNBOUNDED" }, provider);
  }
  assert.deepEqual(codingRowRuntime(row({ provider: "not-a-provider" }), SNAPSHOT), { ok: false, code: "CODE_PROVIDER_UNSUPPORTED" });
});

test("the reservation charges the row's credit weight at its prices and records the snapshot", () => {
  const dedicated = row();
  const built = codingRowRuntime(dedicated, SNAPSHOT);
  const { model, pricing } = codingApiDedicatedModel(dedicated, built, SNAPSHOT);
  const budget = createChatBudget("user", model, 2_000, { totalOutputTokenCap: 4_000, catalogPricing: pricing });
  assert.equal(budget.modelId, "qwen3.7-coder-plus");
  assert.equal(budget.usageCredits, getWeightedUsageCredits({ usageClass: "standard", creditWeight: 9 }, 2_000));
  assert.equal(budget.usageCredits, 9);
  assert.equal(budget.inputUsdPerMillionTokens, 1);
  assert.equal(budget.outputUsdPerMillionTokens, 5);
  assert.equal(budget.cachedInputPriceMultiplier, 1);
  assert.equal(budget.maxOutputTokens, 4_000);
  assert.equal(budget.reservedOutputTokens, 4_000, "the external API reserves the output it sends");
  assert.equal(budget.pricingVersion, `coding_catalog_snapshot:12:${"a".repeat(64)}`);
  assert.equal(budget.costSource, "coding_catalog_snapshot");
  assert.equal(budget.cacheWriteUsdPerMillionTokens, null);
  assert.equal(budget.promptCacheWriteReservedPremiumMicroUsd, 0);
});

test("an Anthropic dedicated row bounds a client's cache marker at 1.25x its own input price", () => {
  const dedicated = row({ provider: "anthropic", apiModelId: "claude-coder-x", modelId: "claude-coder-x" });
  const built = codingRowRuntime(dedicated, SNAPSHOT);
  assert.equal(built.ok, true);
  const { model, pricing } = codingApiDedicatedModel(dedicated, built, SNAPSHOT);
  assert.equal(pricing.cacheWriteUsdPerMillionTokens, 1.25);
  const marked = createChatBudget("user", model, 2_000, {
    totalOutputTokenCap: 4_000,
    promptCachePath: "external_api_messages",
    catalogPricing: pricing,
  });
  assert.equal(marked.cacheWriteUsdPerMillionTokens, 1.25);
  assert.ok(marked.promptCacheWriteReservedPremiumMicroUsd > 0, "the write premium is held before dispatch");
  const unmarked = createChatBudget("user", model, 2_000, { totalOutputTokenCap: 4_000, catalogPricing: pricing });
  assert.equal(unmarked.promptCacheWriteReservedPremiumMicroUsd, 0);
  assert.equal(marked.usageCredits, unmarked.usageCredits, "a cache write is an operational hold, never credits");
});

test("a chat model's reservation is unchanged without catalogue pricing", () => {
  const chatModel = { id: "gpt-6-luna", name: "GPT 6 Luna", apiModel: "gpt-6-luna", provider: "openai", icon: "", bestFor: "", minimumPlan: "Free", usageClass: "standard", enabled: true, status: "enabled" };
  const plain = createChatBudget("user", chatModel, 2_000, { totalOutputTokenCap: 4_000 });
  assert.notEqual(plain.costSource, "coding_catalog_snapshot");
  assert.ok(!String(plain.pricingVersion).startsWith("coding_catalog_snapshot"));
});
