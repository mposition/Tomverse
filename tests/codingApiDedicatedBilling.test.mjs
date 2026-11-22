import assert from "node:assert/strict";
import test from "node:test";

import { createChatBudget } from "../lib/chatSecurity.ts";
import { chatUserMaxInputTokens } from "../lib/chatInputLimits.ts";
import { codingApiDedicatedModel } from "../lib/codingCatalogChannels.ts";
import { codingApiCredit, codingApiCreditFloor, codingApiCreditView, codingRowRuntime, registryPricesFor } from "../lib/codingRowRuntime.ts";
import { codingCreditFloor } from "../lib/modelCatalog.ts";
import { isCreditFloor, suggestCreditFloor } from "../lib/modelAdoptionDraft.ts";
import { CODE_MAX_OUTPUT_TOKENS, codeSchemaAndPrompt } from "../lib/codeManagedCore.ts";
import {
  canonicalJson,
  catalogContentHash,
  CODING_DEFAULT_MAX_OUTPUT_TOKENS,
  codingCatalogRowSchema,
  codingStoredProfileSchema,
  normalizedSnapshotContentHash,
  resolveCodingEntry,
} from "../lib/modelCatalogCore.ts";
import { codingDraftFromAnswer } from "../lib/modelCatalogDraftLlm.ts";
import { getInputCreditMultiplier, getModelUsageProfile, getWeightedUsageCredits, resolveModelRequestPricing } from "../lib/models.ts";
import { COST_PER_CREDIT_CEILING_MICRO_USD } from "../lib/chatCostGuardrails.ts";
import { ChatAccessError } from "../lib/chatSecurity.ts";

// A dedicated coding row on the coding API (owner decisions 2026-11-21): it
// runs as its own published row at that row's prices, through the chat
// reservation, which records the snapshot it was priced from. Its credits there
// follow the chat rule -- its apiCreditWeight, or the chat floor at the chat
// input limit -- while Code's managed path keeps pricing.creditWeight. One
// conversion with Code's managed path (lib/codingRowRuntime.ts).

/**
 * The floor at one input size, worked out by hand: the worst turn in micro-USD
 * over what one credit covers there (input multiplier x US$0.04).
 */
const floorAtInput = (input, output, maxOutputTokens, inputTokens, multiplier = 1) =>
  Math.ceil(Math.ceil(inputTokens * input * multiplier + maxOutputTokens * output) / (getInputCreditMultiplier(inputTokens) * COST_PER_CREDIT_CEILING_MICRO_USD));
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

test("Code's floor above every chat class is worked out directly over every input band, up to the 1,000-credit maximum", () => {
  // US$10/M in, US$40/M out, a 1M window and 32k output: the worst turn is
  // US$11.28 and the x3 band covers US$0.12 a credit, so 94 credits (above
  // apex's 80); every shorter band needs fewer.
  const dear = row({
    capabilities: { ...row().capabilities, maxContextTokens: 1_000_000, maxOutputTokens: 32_000 },
    pricing: { ...row().pricing, inputUsdPerMTok: 10, outputUsdPerMTok: 40 },
  });
  assert.equal(
    suggestCreditFloor({ inputUsdPerMillionTokens: 10, outputUsdPerMillionTokens: 40, maxOutputTokens: 32_000, worstCaseInputTokens: 1_000_000 }).reason,
    "above_every_class"
  );
  const floor = codingCreditFloor(dear);
  assert.equal(floor, 94);
  const cover = (credits) => credits * getInputCreditMultiplier(1_000_000) * COST_PER_CREDIT_CEILING_MICRO_USD;
  assert.ok(cover(floor) >= 11_280_000 && cover(floor - 1) < 11_280_000, "the fewest credits that cover the worst turn");
  // Anthropic's cache write premium is still the input multiplier.
  assert.equal(codingCreditFloor({ ...dear, provider: "anthropic" }), floorAtInput(10, 40, 32_000, 1_000_000, 1.25));
  // Above 1,000 credits it cannot be worked out.
  assert.equal(codingCreditFloor({ ...dear, pricing: { ...dear.pricing, inputUsdPerMTok: 200 } }), null);

  // An output-heavy model is decided by the short-prompt band, as Code charges a
  // 16k prompt at x1: US$1/M in, US$1,000/M out, 32k output costs US$32.016 at
  // 16k (801 credits at x1), more per credit than the whole window (275 at x3).
  const outputHeavy = { ...dear, pricing: { ...dear.pricing, inputUsdPerMTok: 1, outputUsdPerMTok: 1_000 } };
  assert.equal(floorAtInput(1, 1_000, 32_000, 1_000_000), 275);
  assert.equal(codingCreditFloor(outputHeavy), 801);
  assert.equal(codingCreditFloor(outputHeavy), floorAtInput(1, 1_000, 32_000, 16_000));
  // A smaller window is banded up to that window only.
  const smallWindow = { ...outputHeavy, capabilities: { ...outputHeavy.capabilities, maxContextTokens: 64_000 } };
  assert.equal(
    codingCreditFloor(smallWindow),
    Math.max(...[16_000, 50_000, 64_000].map((tokens) => floorAtInput(1, 1_000, 32_000, tokens)))
  );
  // The 1,000-credit edge: 16k at US$2.50/M plus 40k at US$999/M is exactly 1,000 credits at x1; a touch more is refused.
  const edge = (output) => ({ ...dear, capabilities: { ...dear.capabilities, maxOutputTokens: 40_000 }, pricing: { ...dear.pricing, inputUsdPerMTok: 2.5, outputUsdPerMTok: output } });
  assert.equal(codingCreditFloor(edge(999)), 1_000);
  assert.equal(codingCreditFloor(edge(999.001)), null);
  // Within the chat classes the class credits stand as before.
  const cheap = { ...dear, pricing: { ...dear.pricing, inputUsdPerMTok: 0.1, outputUsdPerMTok: 0.4 } };
  assert.equal(
    codingCreditFloor(cheap),
    suggestCreditFloor({ inputUsdPerMillionTokens: 0.1, outputUsdPerMillionTokens: 0.4, maxOutputTokens: 32_000, worstCaseInputTokens: 1_000_000 }).credits
  );
});

test("the floor covers every input band: an output-heavy model is decided by the short-prompt band", () => {
  // US$1/M in, US$20/M out, 32k output. At the 128k limit (x3) 7 credits
  // cover the worst turn (US$0.768 against US$0.84), but a 16k prompt (x1)
  // with a full answer costs US$0.656, which needs 17 credits there.
  const atLimit = floorAtInput(1, 20, 32_000, chatUserMaxInputTokens());
  const shortBand = floorAtInput(1, 20, 32_000, 16_000);
  assert.equal(atLimit, 7);
  assert.equal(shortBand, 17);
  const dear = row({ capabilities: { ...row().capabilities, maxOutputTokens: 32_000 }, pricing: { ...row().pricing, inputUsdPerMTok: 1, outputUsdPerMTok: 20 } });
  assert.equal(codingApiCreditFloor(dear, 32_000), shortBand);
  assert.equal(codingApiCreditFloor(dear, 32_000), bandFloor(1, 20, 32_000));
  // What the floor buys covers the 16k turn at x1: credits x 1 x US$0.04.
  assert.ok(codingApiCreditFloor(dear, 32_000) * 40_000 >= 16_000 * 1 + 32_000 * 20);
  // An input-heavy model is decided by a long-prompt band, never the short one:
  // at the 128k limit, the 100k prompt at x2 is the dearest per credit.
  const inputHeavy = codingApiCreditFloor(row({ pricing: { ...row().pricing, inputUsdPerMTok: 5, outputUsdPerMTok: 1 } }), 4_000);
  assert.equal(inputHeavy, bandFloor(5, 1, 4_000));
  assert.equal(inputHeavy, floorAtInput(5, 1, 4_000, 100_000));
  assert.ok(inputHeavy > floorAtInput(5, 1, 4_000, 16_000));
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

test("a floor above the chat classes (81 to 1,000) is charged, and an override in that range too", () => {
  // US$10/M in, US$50/M out, 64k output: a 16k prompt with a full answer costs
  // US$3.36 at x1, 84 credits -- above the largest chat class (80), which a
  // class search would have refused.
  const dear = row({ capabilities: { ...row().capabilities, maxOutputTokens: 64_000 }, pricing: { ...row().pricing, inputUsdPerMTok: 10, outputUsdPerMTok: 50 } });
  assert.equal(codingApiCreditFloor(dear, 64_000), 84);
  assert.equal(isCreditFloor(suggestCreditFloor({ inputUsdPerMillionTokens: 10, outputUsdPerMillionTokens: 50, maxOutputTokens: 64_000, worstCaseInputTokens: 16_000 })), false);
  assert.deepEqual(apiCredit(dear).credit, { ok: true, credits: 84, basis: "chat_rule_floor", floorCredits: 84 });
  assert.deepEqual(apiCredit({ ...dear, apiCreditWeight: 200 }).credit, { ok: true, credits: 200, basis: "api_override", floorCredits: 84 });
  assert.deepEqual(apiCredit({ ...dear, apiCreditWeight: 1_000 }).credit, { ok: true, credits: 1_000, basis: "api_override", floorCredits: 84 });
  assert.deepEqual(apiCredit({ ...dear, apiCreditWeight: 83 }).credit, { ok: false, reason: "api_credits_below_floor:84", floorCredits: 84 });
  // Exactly at the cap is chargeable; one credit more is not.
  // US$1 in; 64k output at US$624.75/M makes the 16k turn exactly 1,000 credits.
  const at = (output) => row({ capabilities: { ...row().capabilities, maxOutputTokens: 64_000 }, pricing: { ...row().pricing, inputUsdPerMTok: 1, outputUsdPerMTok: output } });
  assert.equal(codingApiCreditFloor(at(624.75), 64_000), 1_000);
  assert.equal(codingApiCreditFloor(at(625.375), 64_000), null, "1,001 credits: above what the coding API charges");
  assert.deepEqual(apiCredit(at(625.375)).credit, { ok: false, reason: "api_credit_floor_unbounded", floorCredits: null });
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
  const resolve = (stored) => resolveCodingEntry({ modelId: "qwen3.7-coder-plus", profile: stored, chat: () => null, providerTerms: () => null }).row;
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

test("a dedicated row on the coding API takes no more input than the chat input limit, long context or not", () => {
  // A 1M-token window: Chat's long context would take a longer prompt.
  const wide = row({ capabilities: { ...row().capabilities, maxContextTokens: 1_000_000 } });
  const { built, credit } = apiCredit(wide);
  const { model, pricing } = codingApiDedicatedModel(wide, built, SNAPSHOT, credit);
  const limit = chatUserMaxInputTokens();
  assert.ok(createChatBudget("user", model, limit, { totalOutputTokenCap: 4_000, catalogPricing: pricing }));
  assert.throws(
    () => createChatBudget("user", model, limit + 1_000, { totalOutputTokenCap: 4_000, catalogPricing: pricing }),
    (error) => error instanceof ChatAccessError && error.code === "CHAT_INPUT_TOKEN_LIMIT" && error.status === 413
  );
  // The same window without the coding catalogue's pricing is Chat's, unchanged.
  if (process.env.CHAT_LONG_CONTEXT_ENABLED !== "0") {
    assert.ok(createChatBudget("user", model, limit + 1_000, { totalOutputTokenCap: 4_000 }));
  }
});

test("a chat model's reservation is unchanged without catalogue pricing", () => {
  const chatModel = { id: "gpt-6-luna", name: "GPT 6 Luna", apiModel: "gpt-6-luna", provider: "openai", icon: "", bestFor: "", minimumPlan: "Free", usageClass: "standard", enabled: true, status: "enabled" };
  const plain = createChatBudget("user", chatModel, 2_000, { totalOutputTokenCap: 4_000 });
  assert.notEqual(plain.costSource, "coding_catalog_snapshot");
  assert.equal(plain.creditBasis, undefined);
  assert.ok(!String(plain.pricingVersion).startsWith("coding_catalog_snapshot"));
});

// Qwen3 Coder Flash drafted from pages with no output limit (owner decision
// 2026-11-22): the draft's 8,192 default is the output limit both paths send,
// so the worst turn the credit floors price is the worst turn that can run.
const QWEN_PRICING = "https://www.alibabacloud.com/help/en/model-studio/model-pricing";
const draftedFlash = () =>
  codingDraftFromAnswer(
    {
      name: "Qwen3 Coder Flash",
      minimumPlan: "Pro",
      capabilities: { toolCalling: "parallel", structuredOutput: "supported", imageInput: false, maxContextTokens: 1_000_000, maxOutputTokens: null },
      pricing: {
        inputUsdPerMTok: 0.3,
        outputUsdPerMTok: 1.5,
        tiers: [
          { upToInputTokens: 32_000, inputUsdPerMTok: 0.3, outputUsdPerMTok: 1.5 },
          { upToInputTokens: 128_000, inputUsdPerMTok: 0.5, outputUsdPerMTok: 2.5 },
          { upToInputTokens: 256_000, inputUsdPerMTok: 0.8, outputUsdPerMTok: 4 },
          { upToInputTokens: null, inputUsdPerMTok: 1.6, outputUsdPerMTok: 9.6 },
        ],
      },
    },
    "qwen",
    "qwen3-coder-flash",
    [QWEN_PRICING],
    codingCreditFloor
  );

test("a draft at the default output cap runs at that cap on the coding API and in Code, at the dearest tier's prices", () => {
  const profile = draftedFlash();
  assert.equal(profile.capabilities.maxOutputTokens, CODING_DEFAULT_MAX_OUTPUT_TOKENS);
  assert.equal(profile.basis.maxOutputTokens, "default");
  // The Code floor: the whole 1M window at the dearest input rate plus the default output at the dearest output rate.
  assert.equal(
    profile.pricing.creditWeight,
    suggestCreditFloor({ inputUsdPerMillionTokens: 1.6, outputUsdPerMillionTokens: 9.6, maxOutputTokens: 8_192, worstCaseInputTokens: 1_000_000 }).credits
  );
  const resolved = resolveCodingEntry({ modelId: "qwen3-coder-flash", profile: { ...profile, channels: ["code", "api"] }, chat: () => null, providerTerms: () => null }).row;
  // The basis stays in the stored profile: the snapshot row does not carry it.
  assert.equal("basis" in resolved, false);
  const withoutBasis = { ...profile };
  delete withoutBasis.basis;
  const plain = resolveCodingEntry({ modelId: "qwen3-coder-flash", profile: { ...withoutBasis, channels: ["code", "api"] }, chat: () => null, providerTerms: () => null }).row;
  assert.equal(catalogContentHash([resolved]), catalogContentHash([plain]));
  const published = codingCatalogRowSchema.parse(JSON.parse(JSON.stringify(resolved)));

  const built = codingRowRuntime(published, SNAPSHOT);
  assert.equal(built.ok, true);
  assert.equal(built.price.maxOutputTokens, 8_192);
  assert.equal(built.price.inputUsdPerMillionTokens, 1.6);
  assert.equal(built.price.outputUsdPerMillionTokens, 9.6);

  // The coding API: the model's output limit, what /models reports, and what a request may reserve and send.
  const credit = codingApiCredit(published, built.price.maxOutputTokens);
  assert.equal(credit.ok, true);
  assert.equal(credit.floorCredits, bandFloor(1.6, 9.6, 8_192));
  const { model, pricing } = codingApiDedicatedModel(published, built, SNAPSHOT, credit);
  assert.equal(model.maxOutputTokens, 8_192);
  assert.equal(resolveModelRequestPricing(model, { estimatedPromptTokens: 1 }).maxOutputTokens, 8_192);
  const asked = createChatBudget("user", model, 2_000, { totalOutputTokenCap: 100_000, catalogPricing: pricing });
  assert.equal(asked.maxOutputTokens, 8_192, "a client asking for more output is held to the cap");
  assert.equal(asked.reservedOutputTokens, 8_192);
  assert.equal(asked.outputUsdPerMillionTokens, 9.6);

  // Code's managed path: the request is refused above the row's cap before any dispatch.
  const request = (maxOutputTokens) => ({
    action: "complete",
    reservationId: "00000000-0000-4000-8000-000000000001",
    callId: "00000000-0000-4000-8000-000000000002",
    role: "executor",
    modelId: "qwen3-coder-flash",
    prompt: { system: "fixture", user: "fixture" },
    schema: { type: "object", properties: {}, additionalProperties: false },
    maxOutputTokens,
  });
  assert.ok(codeSchemaAndPrompt(request(8_192), published) > 0);
  assert.throws(() => codeSchemaAndPrompt(request(8_193), published), /exceeds the selected model's bounds/);
  assert.equal(Math.min(built.price.maxOutputTokens, CODE_MAX_OUTPUT_TOKENS), 8_192);
});

test("rows and snapshots stored with the older structured output values parse and hash as they did", () => {
  const base = row();
  for (const value of ["json_mode", "strict_schema", "forced_tool_use", "response_schema", "none"]) {
    const stored = JSON.parse(JSON.stringify({ ...base, capabilities: { ...base.capabilities, structuredOutput: value } }));
    const parsed = codingCatalogRowSchema.parse(stored);
    assert.equal(parsed.capabilities.structuredOutput, value, "read as stored, not rewritten");
    assert.equal(canonicalJson(parsed), canonicalJson(stored));
    // A published snapshot's hash, read back through today's schema, is the hash it was published with.
    assert.equal(normalizedSnapshotContentHash({ models: [stored] }), catalogContentHash([stored]));
    const { modelId, ...profile } = stored;
    delete profile.source;
    const resolved = resolveCodingEntry({ modelId, profile, chat: () => null, providerTerms: () => null }).row;
    assert.equal(canonicalJson(resolved), canonicalJson(stored));
  }
  // "supported" is a value a row may now carry, and it is offered to Code (only "none" is not).
  const supported = codingCatalogRowSchema.parse({ ...base, capabilities: { ...base.capabilities, structuredOutput: "supported" } });
  assert.equal(codingRowRuntime(supported, SNAPSHOT).ok, true);
});

test("coding notes stay in the stored row: a link or a dedicated row with them resolves and hashes as one without", () => {
  // Owner decision 2026-11-22.
  const notes = { strengths: ["Parallel tool calls"], weaknesses: ["Weak at long contexts"], sources: [QWEN_PRICING], draftedAt: "2026-11-22" };
  const dedicated = draftedFlash();
  const plainDedicated = resolveCodingEntry({ modelId: "qwen3-coder-flash", profile: { ...dedicated, channels: ["code", "api"] }, chat: () => null, providerTerms: () => null }).row;
  const notedDedicated = resolveCodingEntry({
    modelId: "qwen3-coder-flash",
    profile: { ...dedicated, channels: ["code", "api"], codingNotes: notes },
    chat: () => null,
    providerTerms: () => null,
  });
  assert.equal(codingStoredProfileSchema.safeParse({ ...dedicated, codingNotes: notes }).success, true);
  assert.equal("codingNotes" in notedDedicated.row, false);
  assert.equal(canonicalJson(notedDedicated.row), canonicalJson(plainDedicated));
  assert.equal(catalogContentHash([notedDedicated.row]), catalogContentHash([plainDedicated]));
  assert.deepEqual(notedDedicated.stored.codingNotes, notes, "the stored row keeps them for the router and the screen");

  const chat = {
    id: "gpt-6-luna",
    name: "GPT 6 Luna",
    provider: "openai",
    apiModelId: "gpt-6-luna",
    minimumPlan: "Free",
    usageClass: "standard",
    creditWeight: 2,
    enabled: true,
    status: "enabled",
    publiclyListed: true,
    catalogDeleted: false,
    contextWindowTokens: 400_000,
    maxOutputTokens: 32_000,
    imageInput: true,
    price: { inputUsdPerMTok: 1, outputUsdPerMTok: 8, pricingVersion: "v1", effectiveDate: "2026-11-01", verified: true, reasoningBilledSeparately: false },
  };
  const link = { source: "chat", registryModelId: "gpt-6-luna", capabilities: { toolCalling: "basic", structuredOutput: "supported" }, channels: ["api"] };
  const resolveLink = (profile) => resolveCodingEntry({ modelId: "gpt-6-luna", profile, chat: () => chat, providerTerms: () => null });
  const notedLink = resolveLink({ ...link, codingNotes: notes });
  assert.equal(notedLink.problem, null);
  assert.equal(canonicalJson(notedLink.row), canonicalJson(resolveLink(link).row));
  assert.equal(catalogContentHash([notedLink.row]), catalogContentHash([resolveLink(link).row]));
  // A snapshot row never carries them; one that somehow did would not parse as a snapshot row.
  assert.equal(codingCatalogRowSchema.safeParse({ ...notedLink.row, codingNotes: notes }).success, false);
});
