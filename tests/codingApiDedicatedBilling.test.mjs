import assert from "node:assert/strict";
import test from "node:test";

import { createChatBudget } from "../lib/chatSecurity.ts";
import { codingApiDedicatedModel } from "../lib/codingCatalogChannels.ts";
import { codingRowRuntime } from "../lib/codingRowRuntime.ts";
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
