import assert from "node:assert/strict";
import test from "node:test";

import { createChatBudget } from "../lib/chatSecurity.ts";
import { chatUserMaxInputTokens } from "../lib/chatInputLimits.ts";
import { codingApiDedicatedModel } from "../lib/codingCatalogChannels.ts";
import { codingApiCredit, codingApiCreditFloor, codingApiCreditView, codingRowRuntime, registryPricesFor } from "../lib/codingRowRuntime.ts";
import { codingCreditFloor } from "../lib/modelCatalog.ts";
import { isCreditFloor, suggestCreditFloor } from "../lib/modelAdoptionDraft.ts";
import {
  canonicalJson,
  catalogContentHash,
  codingCatalogRowOf,
  codingCatalogRowSchema,
  codingStoredProfileSchema,
  resolveCodingEntry,
} from "../lib/modelCatalogCore.ts";
import { getModelUsageProfile, getWeightedUsageCredits } from "../lib/models.ts";

// A dedicated coding row on the coding API (owner decisions 2026-11-21): it
// runs as its own published row at that row's prices, through the chat
// reservation, which records the snapshot it was priced from. Its credits there
// follow the chat rule -- its apiCreditWeight, or the chat floor at the chat
// input limit -- while Code's managed path keeps pricing.creditWeight. One
// conversion with Code's managed path (lib/codingRowRuntime.ts).

/** The chat floor at one input size: what suggestCreditFloor says for that worst turn. */
const floorAtInput = (input, output, maxOutputTokens, inputTokens, multiplier = 1) => {
  const floor = suggestCreditFloor({ inputUsdPerMillionTokens: input, outputUsdPerMillionTokens: output, maxOutputTokens, inputPriceMultiplier: multiplier, worstCaseInputTokens: inputTokens });
  assert.ok(isCreditFloor(floor));
  return floor.credits;
};
/** The largest floor over the input bands' worst turns (x1 to 16k, x1.5 to 50k, x2 to 100k, x3 to the limit). */
const bandFloor = (input, output, maxOutputTokens, multiplier = 1) =>
  Math.max(...[16_000, 50_000, 100_000, chatUserMaxInputTokens()].map((tokens) => floorAtInput(input, output, maxOutputTokens, tokens, multiplier)));

/** The coding API's credits for a row, as a request is charged. */
const apiCredit = (dedicated) => {
  const built = codingRowRuntime(dedicated, SNAPSHOT);
  assert.equal(built.ok, true);
  const credit = codingApiCredit(dedicated, built.price.maxOutputTokens);
  return { built, credit };
};

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
  const { built, credit } = apiCredit(row());
  assert.equal(credit.ok, true);
  const { model, pricing } = codingApiDedicatedModel(row(), built, SNAPSHOT, credit);
  assert.equal(model.id, "qwen3.7-coder-plus");
  assert.equal(model.apiModel, "qwen3.7-coder-plus");
  assert.equal(model.provider, "qwen");
  assert.equal(getModelUsageProfile(model).credits, credit.credits, "the coding API's credits, not Code's");
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
    creditBasis: { basis: "chat_rule_floor", credits: credit.credits, floorCredits: credit.credits },
  });
});

test("by default a dedicated row's coding API credits are the chat rule's floor, below Code's for a large context", () => {
  // A 1M-token context: Code's floor prices the whole window as input, the
  // coding API only what it accepts (the chat input limit).
  const large = row({
    capabilities: { ...row().capabilities, maxContextTokens: 1_000_000, maxOutputTokens: 16_000 },
    pricing: { ...row().pricing, inputUsdPerMTok: 1, outputUsdPerMTok: 4 },
  });
  const codeFloor = codingCreditFloor(large);
  assert.ok(codeFloor !== null);
  const { credit } = apiCredit({ ...large, pricing: { ...large.pricing, creditWeight: codeFloor } });
  const chatFloor = bandFloor(1, 4, 16_000);
  assert.deepEqual(credit, { ok: true, credits: chatFloor, basis: "chat_rule_floor", floorCredits: chatFloor });
  assert.ok(credit.credits < codeFloor, `coding API ${credit.credits} below Code ${codeFloor}`);
});

test("the floor covers every input band: an output-heavy model is decided by the short-prompt band", () => {
  // US$1/M in, US$20/M out, 32k output. At the 128k limit (x3) the chat floor
  // is 8 credits, but a 16k prompt (x1) with a full answer costs US$0.656,
  // more than 8 credits cover there (US$0.32).
  const atLimit = floorAtInput(1, 20, 32_000, chatUserMaxInputTokens());
  const shortBand = floorAtInput(1, 20, 32_000, 16_000);
  assert.equal(atLimit, 8);
  assert.ok(shortBand > atLimit, `short band ${shortBand} above the limit's ${atLimit}`);
  const dear = row({ capabilities: { ...row().capabilities, maxOutputTokens: 32_000 }, pricing: { ...row().pricing, inputUsdPerMTok: 1, outputUsdPerMTok: 20 } });
  assert.equal(codingApiCreditFloor(dear, 32_000), shortBand);
  assert.equal(codingApiCreditFloor(dear, 32_000), bandFloor(1, 20, 32_000));
  // What the floor buys covers the 16k turn at x1: credits x 1 x US$0.04.
  assert.ok(codingApiCreditFloor(dear, 32_000) * 40_000 >= 16_000 * 1 + 32_000 * 20);
  // An input-heavy model is still decided at the input limit: unchanged.
  assert.equal(codingApiCreditFloor(row({ pricing: { ...row().pricing, inputUsdPerMTok: 5, outputUsdPerMTok: 1 } }), 4_000), floorAtInput(5, 1, 4_000, chatUserMaxInputTokens()));
  // A smaller input limit stops at the limit: no band past it is priced.
  assert.equal(codingApiCreditFloor(dear, 32_000, 10_000), floorAtInput(1, 20, 32_000, 10_000));
});

test("an Anthropic row's floor prices the five-minute cache write at 1.25x its input", () => {
  const base = { capabilities: { ...row().capabilities, maxOutputTokens: 8_000 }, pricing: { ...row().pricing, inputUsdPerMTok: 3, outputUsdPerMTok: 15 } };
  assert.equal(codingApiCreditFloor({ ...row(base), provider: "anthropic" }, 8_000), bandFloor(3, 15, 8_000, 1.25));
  assert.equal(codingApiCreditFloor(row(base), 8_000), bandFloor(3, 15, 8_000, 1));
  // The worst case the floor covers is larger with the write premium.
  const worst = (multiplier) =>
    suggestCreditFloor({ inputUsdPerMillionTokens: 3, outputUsdPerMillionTokens: 15, maxOutputTokens: 8_000, inputPriceMultiplier: multiplier, worstCaseInputTokens: chatUserMaxInputTokens() }).worstCaseMicroUsd;
  assert.ok(worst(1.25) > worst(1));
});

test("an apiCreditWeight at or above the floor is charged; one below it keeps the row off the coding API", () => {
  const { credit: floor } = apiCredit(row());
  const at = apiCredit(row({ apiCreditWeight: floor.floorCredits })).credit;
  assert.deepEqual(at, { ok: true, credits: floor.floorCredits, basis: "api_override", floorCredits: floor.floorCredits });
  const above = apiCredit(row({ apiCreditWeight: floor.floorCredits + 7 })).credit;
  assert.deepEqual(above, { ok: true, credits: floor.floorCredits + 7, basis: "api_override", floorCredits: floor.floorCredits });
  assert.ok(floor.floorCredits > 1, "this row's floor leaves room below it");
  assert.deepEqual(apiCredit(row({ apiCreditWeight: floor.floorCredits - 1 })).credit, {
    ok: false,
    reason: `api_credits_below_floor:${floor.floorCredits}`,
    floorCredits: floor.floorCredits,
  });
  // Code's credits are untouched by either.
  assert.equal(codingApiCreditView(row({ apiCreditWeight: floor.floorCredits + 7 })).codeCredits, 9);
});

test("a row whose floor cannot be worked out is not offered on the coding API", () => {
  // Priced above every class the credit system was sized for.
  const dear = row({ pricing: { ...row().pricing, inputUsdPerMTok: 900, outputUsdPerMTok: 900 } });
  const { credit } = apiCredit(dear);
  assert.deepEqual(credit, { ok: false, reason: "api_credit_floor_unbounded", floorCredits: null });
  assert.equal(codingApiCreditFloor(dear, 0), null, "no output cap, no floor");
  const view = codingApiCreditView(dear);
  assert.equal(view.credits, null);
  assert.equal(view.refusal, "api_credit_floor_unbounded");
});

test("a row without apiCreditWeight hashes exactly as before; the default is never stored", () => {
  const profile = {
    name: "Qwen 3.7 Coder Plus",
    provider: "qwen",
    apiModelId: "qwen3.7-coder-plus",
    minimumPlan: "Pro",
    capabilities: { toolCalling: "parallel", structuredOutput: "strict_schema", imageInput: false, maxContextTokens: 256_000, maxOutputTokens: 32_000 },
    pricing: { inputUsdPerMTok: 1, outputUsdPerMTok: 5, creditWeight: 9, verifiedAt: "2026-11-01", sources: ["https://www.alibabacloud.com/help/en/model-studio/model-pricing"] },
    terms: { allowsResaleAndCodingAgent: true, url: "https://www.alibabacloud.com/help/en/legal/terms", checkedAt: "2026-11-18" },
    retention: { url: "https://www.alibabacloud.com/help/en/legal/privacy", checkedAt: "2026-11-18" },
    processingRegion: "Singapore",
    channels: ["code", "api"],
  };
  const resolve = (stored) =>
    codingCatalogRowOf(resolveCodingEntry({ modelId: "qwen3.7-coder-plus", profile: stored, chat: () => null, providerTerms: () => null, now: new Date("2026-11-21T00:00:00Z") }).row);
  const current = resolve(profile);
  // The row as it was resolved before the field existed.
  const before = { modelId: "qwen3.7-coder-plus", source: "dedicated", ...profile };
  assert.equal(canonicalJson(current), canonicalJson(before));
  assert.equal(catalogContentHash([current]), catalogContentHash([before]));
  assert.ok(!canonicalJson(current).includes("apiCreditWeight"));
  // A snapshot row written before it parses to the same row.
  assert.equal(canonicalJson(codingCatalogRowSchema.parse(JSON.parse(JSON.stringify(before)))), canonicalJson(current));
  // Set, it is part of the row (and of the next publish).
  const set = resolve({ ...profile, apiCreditWeight: 12 });
  assert.equal(set.apiCreditWeight, 12);
  assert.notEqual(catalogContentHash([set]), catalogContentHash([current]));
  assert.equal(codingStoredProfileSchema.safeParse({ ...profile, apiCreditWeight: 0 }).success, false);
  assert.equal(codingStoredProfileSchema.safeParse({ ...profile, apiCreditWeight: 1_001 }).success, false);
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

test("the reservation charges the coding API's credits at the row's prices and records the snapshot and the basis", () => {
  const dedicated = row();
  const { built, credit } = apiCredit(dedicated);
  const { model, pricing } = codingApiDedicatedModel(dedicated, built, SNAPSHOT, credit);
  const budget = createChatBudget("user", model, 2_000, { totalOutputTokenCap: 4_000, catalogPricing: pricing });
  assert.equal(budget.modelId, "qwen3.7-coder-plus");
  assert.equal(budget.usageCredits, getWeightedUsageCredits({ usageClass: "standard", creditWeight: credit.credits }, 2_000));
  assert.deepEqual(budget.creditBasis, { basis: "chat_rule_floor", credits: credit.credits, floorCredits: credit.floorCredits });
  // A larger prompt is charged the chat input multiplier on the same credits.
  const long = createChatBudget("user", model, 100_000, { totalOutputTokenCap: 4_000, catalogPricing: pricing });
  assert.equal(long.usageCredits, getWeightedUsageCredits({ usageClass: "standard", creditWeight: credit.credits }, 100_000));
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
  const { built, credit } = apiCredit(dedicated);
  const { model, pricing } = codingApiDedicatedModel(dedicated, built, SNAPSHOT, credit);
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
  assert.equal(plain.creditBasis, undefined);
  assert.ok(!String(plain.pricingVersion).startsWith("coding_catalog_snapshot"));
});
