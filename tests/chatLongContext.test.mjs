import assert from "node:assert/strict";
import test from "node:test";
import {
    CHAT_LONG_CONTEXT_MICRO_USD_PER_CREDIT_DEFAULT,
    CHAT_USER_MAX_INPUT_TOKENS_DEFAULT,
    chatAccountMaxInputTokens,
    chatLongContextCostCredits,
    chatLongContextSettledCredits,
} from "../lib/chatInputLimits.ts";
import { readFileSync } from "node:fs";
import { CHAT_REQUEST_LIMITS, accountChatMaxInputTokens, createChatBudget } from "../lib/chatSecurity.ts";
import {
    CHAT_MAX_MESSAGE_BODY_BYTES,
    CHAT_MAX_MESSAGE_CHARACTERS,
    CHAT_MAX_STORED_ANSWER_CHARACTERS,
} from "../lib/chatRequestLimits.ts";
import { longContextSettledUsageCost, longContextSettlementRates, providerCallsCover, resolveModelPricing } from "../lib/modelPricing.ts";
import { calculateProviderUsageCost } from "../lib/providerUsageCost.ts";
import { AVAILABLE_MODELS, getModel, getWeightedUsageCredits } from "../lib/models.ts";
import {
    CHAT_ATTACHMENT_CHARACTERS_PER_CONTEXT_TOKEN,
    CHAT_ATTACHMENT_PARSE_CHARACTERS,
} from "../lib/chatAttachmentLimits.ts";

/**
 * Long context (operator decision 2026-11-18): a signed-in account may send up
 * to the model's own context window, and a turn above the flat 128k limit is
 * charged at least its own provider cost. On by default.
 */

const FLAT = CHAT_USER_MAX_INPUT_TOKENS_DEFAULT;
const RATE = CHAT_LONG_CONTEXT_MICRO_USD_PER_CREDIT_DEFAULT;
const OFF = { CHAT_LONG_CONTEXT_ENABLED: "0" };

const withEnv = (values, run) => {
    const saved = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
    Object.assign(process.env, values);
    try {
        return run();
    } finally {
        for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
};

// The worst case a long-context reservation holds: the input and the whole
// output ceiling, without the cache-write premium (not credits).
const tokenCostMicroUsd = (budget) =>
    Math.ceil(budget.inputTokens * budget.inputUsdPerMillionTokens) +
    Math.ceil(budget.maxOutputTokens * budget.outputUsdPerMillionTokens);

test("the input limit is the model's window by default, the flat limit when switched off", () => {
    assert.equal(chatAccountMaxInputTokens({ contextWindowTokens: 1_050_000 }, {}), 1_050_000);
    assert.equal(chatAccountMaxInputTokens({ contextWindowTokens: 1_050_000 }, OFF), FLAT);
});

test("a model with no window, or one smaller than the flat limit, keeps the flat limit", () => {
    assert.equal(chatAccountMaxInputTokens({}, {}), FLAT);
    assert.equal(chatAccountMaxInputTokens({ contextWindowTokens: null }, {}), FLAT);
    assert.equal(chatAccountMaxInputTokens({ contextWindowTokens: 64_000 }, {}), FLAT);
});

test("a flat price valid only to a tier boundary holds the limit there", () => {
    assert.equal(
        chatAccountMaxInputTokens({ contextWindowTokens: 1_050_000, flatPriceMaxPromptTokens: 272_000 }, {}),
        272_000
    );
    // Never below the flat limit, which the flat price already covers.
    assert.equal(
        chatAccountMaxInputTokens({ contextWindowTokens: 1_050_000, flatPriceMaxPromptTokens: 64_000 }, {}),
        FLAT
    );
});

test("cost credits are zero at or below the flat limit and cost / rate above it", () => {
    assert.equal(chatLongContextCostCredits({ estimatedInputTokens: FLAT, reservedCostMicroUsd: 9_000_000 }, {}), 0);
    assert.equal(
        chatLongContextCostCredits({ estimatedInputTokens: FLAT + 1, reservedCostMicroUsd: 5_000_001 }, {}),
        Math.ceil(5_000_001 / RATE)
    );
    assert.equal(
        chatLongContextCostCredits({ estimatedInputTokens: FLAT + 1, reservedCostMicroUsd: 5_000_000 }, OFF),
        0
    );
    assert.equal(
        chatLongContextCostCredits(
            { estimatedInputTokens: FLAT + 1, reservedCostMicroUsd: 5_000_000 },
            { CHAT_LONG_CONTEXT_MICRO_USD_PER_CREDIT: "5000" }
        ),
        1_000
    );
});

const SOL = getModel("gpt-5-6-sol");

test("a 1M-token account turn is accepted and charged its cost, not the 3x ceiling", () => {
    const budget = createChatBudget("user", SOL, 1_000_000);
    const flatCredits = getWeightedUsageCredits(SOL, 1_000_000);
    assert.ok(budget.usageCredits > flatCredits, `${budget.usageCredits} > ${flatCredits}`);
    assert.equal(budget.usageCredits, Math.ceil(tokenCostMicroUsd(budget) / RATE));
    // No turn above the flat limit sells a credit below the rate.
    assert.ok(tokenCostMicroUsd(budget) / budget.usageCredits <= RATE);
});

test("a turn at or below the flat limit is charged exactly what it was", () => {
    for (const tokens of [1_000, 100_000, FLAT]) {
        assert.equal(
            createChatBudget("user", SOL, tokens).usageCredits,
            getWeightedUsageCredits(SOL, tokens),
            `${tokens} tokens`
        );
    }
});

test("a turn past the model's window is still refused", () => {
    assert.throws(() => createChatBudget("user", SOL, SOL.contextWindowTokens + 1), /token budget/i);
});

test("a model that declares no window keeps the 128k limit", () => {
    const pro = getModel("gemini-3-1-pro");
    assert.equal(pro.contextWindowTokens, undefined);
    assert.throws(() => createChatBudget("user", pro, FLAT + 1), /token budget/i);
});

test("switched off, an account is held to the flat limit again", () => {
    withEnv(OFF, () => {
        assert.throws(() => createChatBudget("user", SOL, FLAT + 1), /token budget/i);
    });
});

test("the attachment parse budget covers the largest model context window", () => {
    const largest = Math.max(...AVAILABLE_MODELS.map((model) => model.contextWindowTokens ?? 0));
    assert.ok(CHAT_ATTACHMENT_PARSE_CHARACTERS >= largest * CHAT_ATTACHMENT_CHARACTERS_PER_CONTEXT_TOKEN);
    assert.ok(CHAT_ATTACHMENT_PARSE_CHARACTERS >= 2_000_000);
});

// Review r-20261118-041545-22a7ea, blocker: the prompt-cache write premium is an
// operational reservation, never part of usageCredits.
test("a long Anthropic turn is not charged its cache-write premium as credits", () => {
    const opus = getModel("claude-opus-4-8");
    const cached = createChatBudget("user", opus, 300_000, { promptCachePath: "chat_turn" });
    assert.ok(cached.promptCacheWriteReservedPremiumMicroUsd > 0, "the premium is still reserved");
    const plain = createChatBudget("user", opus, 300_000);
    assert.equal(cached.usageCredits, plain.usageCredits);
    assert.equal(cached.usageCredits, Math.ceil(tokenCostMicroUsd(cached) / RATE));
});

// Review r-20261118-045351-43dc45, blocker: the reservation held only the
// typical output, and settlement never raised it. It now holds the whole
// output ceiling and settlement charges the actual cost.
test("a long turn reserves the whole output ceiling and carries its settlement terms", () => {
    const luna = getModel("gpt-6-luna");
    const budget = createChatBudget("user", luna, 200_000);
    const typical = resolveModelPricing(luna, { estimatedPromptTokens: 200_000 }).reservationOutputTokens;
    assert.ok(budget.maxOutputTokens > typical, "the ceiling, not the typical answer, is held");
    assert.equal(budget.usageCredits, Math.ceil(tokenCostMicroUsd(budget) / RATE));
    assert.deepEqual(budget.longContextSettlement, {
        microUsdPerCredit: RATE,
        floorCredits: getWeightedUsageCredits(luna, 200_000),
    });
    assert.equal(createChatBudget("user", luna, FLAT).longContextSettlement, null);
});

// Review r-20261118-052526-cb5f06: the provider budget saw only the typical
// output while the credits held the ceiling.
test("a long turn's provider-cost reservation holds the whole output ceiling too", () => {
    const luna = getModel("gpt-6-luna");
    const long = createChatBudget("user", luna, 200_000);
    assert.equal(long.reservedOutputTokens, long.maxOutputTokens);
    const flat = createChatBudget("user", luna, FLAT);
    assert.ok(flat.reservedOutputTokens < flat.maxOutputTokens, "a flat turn reserves as before");
});

test("every attempt snapshot carries what the long-context rule needs", () => {
    const route = readFileSync(new URL("../app/api/chat/route.ts", import.meta.url), "utf8");
    // The fallback replaces the primary's price; it carries its own tier facts.
    assert.match(
        route,
        /pricingVersion: plan\.budget\.pricingVersion \?\? null,[\s\S]{0,300}longContextThresholdTokens: plan\.budget\.longContextThresholdTokens,\s*costSource: plan\.budget\.costSource \?\? null,/
    );
    const security = readFileSync(new URL("../lib/chatSecurity.ts", import.meta.url), "utf8");
    const single = security.slice(security.indexOf("const singleAttempt: LedgerAttempt | null ="));
    assert.match(single.slice(0, 1500), /longContextThresholdTokens:\s*canonical\.longContextThresholdTokens \?\? null,\s*costSource: canonical\.costSource \?\? null,/);
});

test("one message may be as long as the largest model window holds", () => {
    const largest = Math.max(...AVAILABLE_MODELS.map((model) => model.contextWindowTokens ?? 0));
    assert.ok(CHAT_REQUEST_LIMITS.maxMessageCharacters >= largest * 5);
    assert.equal(CHAT_MAX_MESSAGE_CHARACTERS, CHAT_REQUEST_LIMITS.maxMessageCharacters);
    assert.equal(CHAT_MAX_MESSAGE_BODY_BYTES, CHAT_REQUEST_LIMITS.maxBodyBytes);
    const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
    for (const path of [
        "app/api/chat/preflight/route.ts",
        "app/api/chat/availability/route.ts",
        "app/api/chat/context/route.ts",
        "app/api/conversations/[conversationId]/messages/route.ts",
        "lib/chatComposerDraftCore.ts",
        "lib/chatDraftMessageConsume.ts",
        // A guest message the chat accepted can be moved into the account.
        "app/api/conversations/import-guest/route.ts",
    ]) {
        const text = read(path);
        assert.match(text, /CHAT_MAX_MESSAGE_CHARACTERS/, path);
        assert.doesNotMatch(text, /\b50_000\b/, path);
    }
    for (const path of [
        "app/api/chat/preflight/route.ts",
        "app/api/chat/availability/route.ts",
        "app/api/chat/context/route.ts",
        "app/api/conversations/[conversationId]/messages/route.ts",
        "app/api/conversations/[conversationId]/messages/receipt/route.ts",
        "app/api/products/chat/drafts/[scopeKey]/route.ts",
        "app/api/conversations/import-guest/route.ts",
    ]) {
        assert.match(read(path), /readLimitedJson\([\s\S]{0,40}CHAT_MAX_MESSAGE_BODY_BYTES/, path);
    }
});

// Review r-20261118-061355-5bf791: the long-context decision is the measured
// input, the figure the input limit is checked against -- never the
// reservation-only image allowance.
test("a turn under the flat limit stays flat whatever its image allowance", () => {
    const luna = getModel("gpt-6-luna");
    const withImage = createChatBudget("user", luna, 115_000, { reservationOnlyInputTokens: 16_000 });
    assert.equal(withImage.longContextSettlement, null);
    assert.equal(withImage.usageCredits, getWeightedUsageCredits(luna, 131_000));
    assert.ok(withImage.reservedOutputTokens < withImage.maxOutputTokens, "the typical answer is reserved");
    assert.equal(withImage.longContextThresholdTokens, null);
});

// Review r-20261118-064619-ed3e4c: the tier margin applies to what is sent,
// never to the unsent image allowance.
test("an unsent image allowance does not push a short-tier prompt onto the long rate", () => {
    const luna = getModel("gpt-6-luna");
    // 210k sent x 1.25 = 262.5k: short tier (Luna steps at 272k)...
    const sentOnly = createChatBudget("user", luna, 210_000);
    assert.equal(sentOnly.longContextThresholdTokens, null);
    // ...and still short with 16k of unsent allowance on top.
    const withAllowance = createChatBudget("user", luna, 210_000, { reservationOnlyInputTokens: 16_000 });
    assert.equal(withAllowance.longContextThresholdTokens, null);
    assert.equal(withAllowance.inputUsdPerMillionTokens, sentOnly.inputUsdPerMillionTokens);
});

// Review r-20261118-071721-860078: a caller that names its own output cap
// (Research Preview) keeps it, so its admission check still matches.
test("an explicit output cap is not shrunk to the window room", () => {
    const luna = getModel("gpt-6-luna");
    const capped = createChatBudget("user", luna, luna.contextWindowTokens - 1_000, { totalOutputTokenCap: 4_096 });
    assert.equal(capped.maxOutputTokens, 4_096);
});

test("the attempt ledger keeps the settled rates and the price's own source", () => {
    const ledger = readFileSync(new URL("../lib/chatAttemptCostLedger.ts", import.meta.url), "utf8");
    assert.match(ledger, /pricingSnapshot: \{\s*\.\.\.longContextSettlementRates\(attempt\.price, attempt\.inputTokens, attempt\.providerCalls, attempt\),\s*reservationCostSource: attempt\.price\.costSource \?\? null,/);
});

// Review r-20261118-075201-6d1a48: the public guide states the floor, uses the
// configured threshold, and says nothing when long context is off.
test("the public credit guide describes long turns only as configured", () => {
    const pricing = readFileSync(new URL("../components/marketing/PricingPageContent.tsx", import.meta.url), "utf8");
    const notes = [...pricing.matchAll(/longContextChargeNote: \(tokens\) => `([^`]+)`/g)].map((match) => match[1]);
    assert.equal(notes.length, 8);
    for (const note of notes) {
        assert.ok(note.includes("${tokens}"), note);
        assert.doesNotMatch(note, /128[,. ]000/, note);
    }
    // The multiplier sentence no longer carries a fixed threshold.
    for (const match of pricing.matchAll(/longContextBody: "([^"]+)"/g)) {
        assert.doesNotMatch(match[1], /128[,. ]000/);
    }
    assert.match(
        pricing,
        /billing\.config\?\.appLongContext === true && billing\.config\.appInputTokenLimit\s*\?\s*` \$\{creditGuide\.longContextChargeNote\(numberFormatter\.format\(billing\.config\.appInputTokenLimit\)\)\}`/
    );
});

test("one decision drives every long-context rule", () => {
    const source = readFileSync(new URL("../lib/chatSecurity.ts", import.meta.url), "utf8");
    assert.match(source, /const longContextTurn =\s*chatLongContextEnabled\(\) && estimatedInputTokens > chatUserMaxInputTokens\(\);/);
    assert.match(source, /longContextTurn\s*\?\s*Math\.ceil\(\s*Math\.max\(0, tokens - reservationOnlyInputTokens\) \*\s*LONG_CONTEXT_TIER_ESTIMATE_MARGIN/);
    assert.match(source, /requestedTotalOutputCap === undefined && !longContextTurn/);
    assert.match(source, /const longContextCredits = longContextTurn\s*\?/);
});

// Reviews r-20261118-064619-ed3e4c and r-20261118-075201-6d1a48: a long guest
// answer neither refuses the whole import nor is cut -- it is stored whole,
// under the same one-message limit a question is held to.
test("guest import keeps every message whole, under one limit", () => {
    const route = readFileSync(new URL("../app/api/conversations/import-guest/route.ts", import.meta.url), "utf8");
    assert.match(route, /content: z\.string\(\)\.max\(CHAT_MAX_MESSAGE_CHARACTERS\)/);
    assert.doesNotMatch(route, /Answer content is too long|storedAnswerContent|\.transform\(/);
    assert.ok(CHAT_MAX_MESSAGE_CHARACTERS > CHAT_MAX_STORED_ANSWER_CHARACTERS);
});

// Same review: the answer can only use the room the window leaves.
test("a long turn reserves no more output than the window leaves", () => {
    const luna = getModel("gpt-6-luna");
    const budget = createChatBudget("user", luna, luna.contextWindowTokens - 1_000);
    assert.ok(budget.maxOutputTokens <= luna.contextWindowTokens - budget.inputTokens, `${budget.maxOutputTokens}`);
    assert.equal(budget.reservedOutputTokens, budget.maxOutputTokens);
    // A flat turn keeps the model's own ceiling; the route fits it later.
    const flat = createChatBudget("user", luna, 10_000);
    assert.equal(flat.maxOutputTokens, resolveModelPricing(luna, { estimatedPromptTokens: 10_000 }).maxOutputTokens);
});

test("settlement charges the actual cost, between the flat floor and the flat rule", () => {
    const settlement = { microUsdPerCredit: RATE, floorCredits: 9 };
    const settle = (flatSettledCredits, tokenCostMicroUsd, searchSurchargeCredits = 0, reservedCredits = flatSettledCredits) =>
        chatLongContextSettledCredits({ settlement, flatSettledCredits, reservedCredits, tokenCostMicroUsd, searchSurchargeCredits });
    // Review r-20261118-054146-5cc718: a cancelled, output-heavy turn is
    // capped by the reservation, not by the token-count share of it.
    assert.equal(settle(30, 200_000, 0, 200), 80);
    // A short answer refunds most of the worst case.
    assert.equal(settle(200, 50_000), 20);
    // Never below the flat-weighted credits.
    assert.equal(settle(200, 1_000), 9);
    // Never above what the flat rule settles (the reservation).
    assert.equal(settle(200, 10_000_000), 200);
    // A search that ran keeps its surcharge on top.
    assert.equal(settle(208, 50_000, 8), 28);
    // Nothing charged stays nothing charged.
    assert.equal(settle(0, 50_000), 0);
    // A flat reservation settles by the flat rule.
    assert.equal(
        chatLongContextSettledCredits({ settlement: null, flatSettledCredits: 24, reservedCredits: 24, tokenCostMicroUsd: 9e9, searchSurchargeCredits: 0 }),
        24
    );
});

test("single-attempt settlement routes long-context credits through the cost rule", () => {
    const source = readFileSync(new URL("../lib/chatSecurity.ts", import.meta.url), "utf8");
    const settle = source.slice(source.indexOf("const flatSettledCredits = getSettledUsageCredits({"));
    assert.ok(settle.length > 0);
    assert.match(settle, /const actualCredits = chatLongContextSettledCredits\(\{\s*settlement: canonical\.longContextSettlement,/);
    assert.match(source, /longContextSettlement: budget\.longContextSettlement \?\? null,/);
});

// Review, major: a flat environment price is a flat price too.
test("an environment flat price holds the limit at the first tier boundary", () => {
    const luna = getModel("gpt-6-luna");
    assert.equal(accountChatMaxInputTokens(luna), luna.contextWindowTokens);
    withEnv({ CHAT_MODEL_GPT_6_LUNA_INPUT_USD_PER_MILLION: "0.2" }, () => {
        assert.equal(accountChatMaxInputTokens(luna), 272_000);
        assert.throws(() => createChatBudget("user", luna, 272_001), /token budget/i);
    });
});

// Review, major: a boundary below the window is reachable.
test("above the flat limit the tier is chosen with a quarter of room", () => {
    const luna = getModel("gpt-6-luna");
    // 230k x 1.25 = 287.5k: past Luna's 272k boundary, so priced long.
    const near = createChatBudget("user", luna, 230_000);
    assert.equal(near.longContextThresholdTokens, 272_000);
    // 200k x 1.25 = 250k: still short.
    assert.equal(createChatBudget("user", luna, 200_000).longContextThresholdTokens, null);
    // At or below the flat limit nothing moves.
    assert.equal(createChatBudget("user", luna, FLAT).longContextThresholdTokens, null);
});

test("settlement records a crossed tier at the higher rate", () => {
    const short = resolveModelPricing(getModel("gpt-6-luna"), { estimatedPromptTokens: 1_000 });
    const long = resolveModelPricing(getModel("gpt-6-luna"), { estimatedPromptTokens: 300_000 });
    const snapshot = {
        modelId: "gpt-6-luna",
        inputUsdPerMillionTokens: short.inputUsdPerMillionTokens,
        outputUsdPerMillionTokens: short.outputUsdPerMillionTokens,
        cacheWriteUsdPerMillionTokens: short.cacheWriteUsdPerMillionTokens,
        longContextThresholdTokens: null,
        pricingVersion: short.pricingVersion,
        costSource: short.costSource,
    };
    assert.equal(short.costSource, "registry");
    assert.equal(longContextSettlementRates(snapshot, 250_000), snapshot);
    const crossed = longContextSettlementRates(snapshot, 300_000);
    assert.equal(crossed.inputUsdPerMillionTokens, long.inputUsdPerMillionTokens);
    assert.equal(crossed.outputUsdPerMillionTokens, long.outputUsdPerMillionTokens);
    assert.equal(crossed.longContextThresholdTokens, 272_000);
    // Already priced long: unchanged.
    const reservedLong = { ...snapshot, ...long, modelId: "gpt-6-luna", longContextThresholdTokens: 272_000 };
    assert.equal(longContextSettlementRates(reservedLong, 900_000), reservedLong);
    // A snapshot above the tier's rate is never lowered.
    const dear = { ...snapshot, inputUsdPerMillionTokens: 99, outputUsdPerMillionTokens: 99 };
    assert.equal(longContextSettlementRates(dear, 300_000).inputUsdPerMillionTokens, 99);
});

// Review r-20261118-080744-15bf85: the estimate margin may reserve the long
// rate for a prompt that arrives under the boundary; the provider charges the
// short rate there, and so does settlement -- credits and provider cost alike.
test("a long-rate reservation whose prompt stayed under the boundary settles at the short rate", () => {
    const short = resolveModelPricing(getModel("gpt-6-luna"), { estimatedPromptTokens: 1_000 });
    const long = resolveModelPricing(getModel("gpt-6-luna"), { estimatedPromptTokens: 300_000 });
    assert.ok(long.inputUsdPerMillionTokens > short.inputUsdPerMillionTokens);
    const reservedLong = {
        modelId: "gpt-6-luna",
        inputUsdPerMillionTokens: long.inputUsdPerMillionTokens,
        outputUsdPerMillionTokens: long.outputUsdPerMillionTokens,
        cacheWriteUsdPerMillionTokens: long.cacheWriteUsdPerMillionTokens,
        longContextThresholdTokens: 272_000,
        pricingVersion: long.pricingVersion,
        costSource: long.costSource,
    };
    // 230k x 1.25 = 287.5k reserved long; 230k actually sent.
    const settled = longContextSettlementRates(reservedLong, 230_000);
    assert.equal(settled.inputUsdPerMillionTokens, short.inputUsdPerMillionTokens);
    assert.equal(settled.outputUsdPerMillionTokens, short.outputUsdPerMillionTokens);
    assert.equal(settled.longContextThresholdTokens, null);
    // At the boundary itself the prompt is still short.
    assert.equal(longContextSettlementRates(reservedLong, 272_000).longContextThresholdTokens, null);
    // A lowering never raises a snapshot rate already under the short one.
    const cheap = { ...reservedLong, inputUsdPerMillionTokens: 0.01 };
    assert.equal(longContextSettlementRates(cheap, 230_000).inputUsdPerMillionTokens, 0.01);
    // Under another price version or a flat price nothing moves.
    const stale = { ...reservedLong, pricingVersion: "openai-gpt-6-luna-1999-01-01" };
    assert.equal(longContextSettlementRates(stale, 230_000), stale);
    const flat = { ...reservedLong, costSource: "model_registry_override" };
    assert.equal(longContextSettlementRates(flat, 230_000), flat);
});

// Review r-20261118-090529-1f7c7f: with the SDK's per-step usage, every call is
// settled at the tier its own prompt fell in.
test("a multi-call turn settles each call at its own tier", () => {
    const short = resolveModelPricing(getModel("gpt-6-luna"), { estimatedPromptTokens: 1_000 });
    const long = resolveModelPricing(getModel("gpt-6-luna"), { estimatedPromptTokens: 300_000 });
    const reservedLong = {
        modelId: "gpt-6-luna",
        inputUsdPerMillionTokens: long.inputUsdPerMillionTokens,
        outputUsdPerMillionTokens: long.outputUsdPerMillionTokens,
        longContextThresholdTokens: 272_000,
        pricingVersion: long.pricingVersion,
        costSource: long.costSource,
        providerCallPasses: 4,
    };
    // Four 230k calls: each under 272k, so all short, though they sum to 920k.
    const four = Array.from({ length: 4 }, () => ({ inputTokens: 230_000, outputTokens: 2_000 }));
    const fourTotals = { inputTokens: 920_000, outputTokens: 8_000 };
    const allShort = longContextSettlementRates(reservedLong, 920_000, four, fourTotals);
    assert.equal(allShort.inputUsdPerMillionTokens, short.inputUsdPerMillionTokens);
    assert.equal(allShort.outputUsdPerMillionTokens, short.outputUsdPerMillionTokens);
    assert.equal(allShort.longContextThresholdTokens, null);
    // One short call and one long: priced on the totals, the blended rates
    // give exactly the sum of the two calls' own costs.
    const mixed = [
        { inputTokens: 200_000, outputTokens: 1_000 },
        { inputTokens: 300_000, outputTokens: 3_000 },
    ];
    const blended = longContextSettlementRates({ ...reservedLong, inputUsdPerMillionTokens: short.inputUsdPerMillionTokens,
        outputUsdPerMillionTokens: short.outputUsdPerMillionTokens, longContextThresholdTokens: null }, 500_000, mixed,
        { inputTokens: 500_000, outputTokens: 4_000 });
    const expectedInput = 200_000 * short.inputUsdPerMillionTokens + 300_000 * long.inputUsdPerMillionTokens;
    const expectedOutput = 1_000 * short.outputUsdPerMillionTokens + 3_000 * long.outputUsdPerMillionTokens;
    assert.ok(Math.abs(blended.inputUsdPerMillionTokens * 500_000 - expectedInput) < 1e-6);
    assert.ok(Math.abs(blended.outputUsdPerMillionTokens * 4_000 - expectedOutput) < 1e-6);
    assert.equal(blended.longContextThresholdTokens, 272_000);
    // A flat or stale price is never moved, call by call either.
    const flat = { ...reservedLong, costSource: "model_registry_override" };
    assert.equal(longContextSettlementRates(flat, 920_000, four, fourTotals).inputUsdPerMillionTokens, long.inputUsdPerMillionTokens);
});

// Review r-20261118-102103-16e00a: a step list is used only when it accounts
// for every figure of the totals, cache reads and writes included, and the
// rates recorded are always the ones the cost was priced at.
test("a step list whose cache figures disagree with the totals is not used", () => {
    const short = resolveModelPricing(getModel("gpt-6-luna"), { estimatedPromptTokens: 1_000 });
    const long = resolveModelPricing(getModel("gpt-6-luna"), { estimatedPromptTokens: 300_000 });
    const snapshot = {
        modelId: "gpt-6-luna",
        inputUsdPerMillionTokens: long.inputUsdPerMillionTokens,
        outputUsdPerMillionTokens: long.outputUsdPerMillionTokens,
        cachedInputPriceMultiplier: long.cachedInputPriceMultiplier,
        longContextThresholdTokens: 272_000,
        pricingVersion: long.pricingVersion,
        costSource: long.costSource,
        providerCallPasses: 2,
    };
    const calls = [
        { inputTokens: 230_000, outputTokens: 1_000, cachedInputTokens: 0, cacheWriteInputTokens: 0 },
        { inputTokens: 240_000, outputTokens: 1_000, cachedInputTokens: 0, cacheWriteInputTokens: 0 },
    ];
    // The totals record cache reads the steps do not: not covered.
    const cachedTotals = { inputTokens: 470_000, outputTokens: 2_000, cachedInputTokens: 200_000 };
    assert.equal(providerCallsCover(calls, cachedTotals), false);
    assert.equal(
        longContextSettledUsageCost(snapshot, cachedTotals, calls).totalCostMicroUsd,
        longContextSettledUsageCost(snapshot, cachedTotals).totalCostMicroUsd
    );
    assert.equal(providerCallsCover(calls, { ...cachedTotals, cachedInputTokens: 0, cacheWriteInputTokens: 5 }), false);
    // Covered: the recorded rates are the per-call ones; not covered, the
    // summed-input rule's -- exactly what each cost used.
    const covered = { inputTokens: 470_000, outputTokens: 2_000 };
    assert.equal(providerCallsCover(calls, covered), true);
    assert.equal(longContextSettlementRates(snapshot, 470_000, calls, covered).inputUsdPerMillionTokens, short.inputUsdPerMillionTokens);
    assert.equal(longContextSettlementRates(snapshot, 470_000, calls, { ...covered, outputTokens: 9 }).inputUsdPerMillionTokens, long.inputUsdPerMillionTokens);
    // Without the totals a call list is never used.
    assert.equal(longContextSettlementRates(snapshot, 470_000, calls).inputUsdPerMillionTokens, long.inputUsdPerMillionTokens);
    const ledger = readFileSync(new URL("../lib/chatAttemptCostLedger.ts", import.meta.url), "utf8");
    assert.ok(ledger.includes("longContextSettlementRates(attempt.price, attempt.inputTokens, attempt.providerCalls, attempt)"));
});

test("the per-step usage reaches every settlement path", () => {
    const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
    const route = read("app/api/chat/route.ts");
    assert.match(route, /const providerCalls = await providerCallUsage\(dispatched\.stream\);/);
    assert.match(route, /providerCalls: await providerCallUsage\(dispatched\.stream\),/);
    assert.match(route, /providerCalls: usage\?\.providerCalls,\s*outcome,/);
    assert.match(route, /inputTokens: settledInputTokens,\s*providerCalls: usage\?\.providerCalls,/);
    const security = read("lib/chatSecurity.ts");
    // Provider cost and credits alike are the sum of the calls.
    assert.match(security, /const tokenCostBreakdown = longContextSettledUsageCost\(\s*snapshotRates,\s*settledUsage,\s*usage\.providerCalls\s*\);/);
    assert.match(security, /longContextSettledUsageCost\(\s*billedAttempt \? billedAttempt\.price : snapshotRates,\s*settledUsage,\s*usage\.providerCalls,\s*\{ pricedCacheWrites: false \}\s*\)/);
    assert.match(security, /providerCalls: billedAttempt\.providerCalls,/);
    assert.match(security, /inputTokens: actualInput,\s*providerCalls: usage\.providerCalls,/);
    assert.match(read("lib/chatMultiAttemptSettlement.ts"), /longContextSettledUsageCost\(\s*attempt\.price,\s*attempt,\s*attempt\.providerCalls\s*\)/);
    assert.match(read("lib/chatAttemptCostLedger.ts"), /longContextSettledUsageCost\(attempt\.price, attempt, attempt\.providerCalls\)/);
    // Each step's own cache split travels with it.
    assert.match(route, /cachedInputTokens: Math\.max\(0, step\.usage\.inputTokenDetails\?\.cacheReadTokens \?\? 0\)/);
});

// Review r-20261118-092832-51f594: calls differ in how much was cached, so the
// turn's cost is the sum of each call's own cost -- never averaged rates.
test("a multi-call turn's cost is the sum of each call's own cost, cache split included", () => {
    const short = resolveModelPricing(getModel("gpt-6-luna"), { estimatedPromptTokens: 1_000 });
    const long = resolveModelPricing(getModel("gpt-6-luna"), { estimatedPromptTokens: 300_000 });
    const snapshot = {
        modelId: "gpt-6-luna",
        inputUsdPerMillionTokens: long.inputUsdPerMillionTokens,
        outputUsdPerMillionTokens: long.outputUsdPerMillionTokens,
        cachedInputPriceMultiplier: long.cachedInputPriceMultiplier,
        cacheWriteUsdPerMillionTokens: long.cacheWriteUsdPerMillionTokens,
        longContextThresholdTokens: 272_000,
        pricingVersion: long.pricingVersion,
        costSource: long.costSource,
        providerCallPasses: 2,
    };
    // A short call mostly cached, then a long one not cached at all.
    const calls = [
        { inputTokens: 200_000, cachedInputTokens: 180_000, cacheWriteInputTokens: 0, outputTokens: 1_000 },
        { inputTokens: 300_000, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 2_000 },
    ];
    const at = (tier, call) => calculateProviderUsageCost({
        ...call,
        inputUsdPerMillionTokens: tier.inputUsdPerMillionTokens,
        outputUsdPerMillionTokens: tier.outputUsdPerMillionTokens,
        cachedInputPriceMultiplier: tier.cachedInputPriceMultiplier,
        cacheWriteUsdPerMillionTokens: tier.cacheWriteUsdPerMillionTokens ?? null,
    }).totalCostMicroUsd;
    const expected = at(short, calls[0]) + at(long, calls[1]);
    const totals = { inputTokens: 500_000, cachedInputTokens: 180_000, cacheWriteInputTokens: 0, outputTokens: 3_000 };
    const settled = longContextSettledUsageCost(snapshot, totals, calls);
    assert.equal(settled.totalCostMicroUsd, expected);
    assert.equal(settled.cachedInputTokens, 180_000);
    // One call: the one-call rule, on the totals.
    const one = longContextSettledUsageCost({ ...snapshot, providerCallPasses: null }, calls[0]);
    assert.equal(one.totalCostMicroUsd, at(short, calls[0]));
    // The credit view counts written tokens as plain input.
    const written = [{ ...calls[0], cachedInputTokens: 0, cacheWriteInputTokens: 50_000 }, calls[1]];
    const writtenTotals = { inputTokens: 500_000, cachedInputTokens: 0, cacheWriteInputTokens: 50_000, outputTokens: 3_000 };
    const credit = longContextSettledUsageCost(snapshot, writtenTotals, written, { pricedCacheWrites: false });
    assert.equal(credit.cacheWriteInputCostMicroUsd, 0);
    assert.equal(credit.totalCostMicroUsd, at(short, { ...written[0], cacheWriteInputTokens: 0 }) + at(long, calls[1]));
});

// Same review: the SDK's `usage` is already the sum of every step, so the
// totals settled beside the per-call figures are the whole turn's.
// Review r-20261118-105614-1047a3: and at runtime too -- the stream result's
// `usage` getter returns `totalUsage`, the aggregate of every step.
test("the installed SDK's stream result returns totalUsage as usage at runtime", () => {
    const runtime = readFileSync(new URL("../node_modules/ai/dist/index.js", import.meta.url), "utf8");
    const totalAt = runtime.indexOf("  get totalUsage() {\n    this.consumeStream();");
    assert.ok(totalAt > 0);
    const usageAt = runtime.lastIndexOf("  get usage() {", totalAt);
    assert.match(runtime.slice(usageAt, usageAt + 60), /get usage\(\) \{\s*return this\.totalUsage;/);
});

// Same review: the steps of a long-context tool loop share one output budget
// and the loop answers on its last reserved call.
test("a long-context tool loop shares its output budget and answers within its calls", async () => {
    const { longContextToolLoopStep, LongContextToolLoopLimitError } = await import("../lib/chatLongContextToolLoop.ts");
    const { estimatePromptTokens } = await import("../lib/chatTokenEstimate.ts");
    const used = (input, output) => ({ usage: { inputTokens: input, outputTokens: output } });
    const base = [{ role: "user", content: "question" }];
    // Messages that grew by at least `tokens` since `base` (a tool result).
    const grown = (tokens) => {
        let text = "";
        while (estimatePromptTokens(JSON.stringify([...base, { role: "tool", content: text }])) -
            estimatePromptTokens(JSON.stringify(base)) < tokens) text += "result text ".repeat(500);
        return [...base, { role: "tool", content: text }];
    };
    const limits = { maxOutputTokens: 10_000, inputTokens: 4_000_000, firstPromptTokens: 200_000, callCap: 4, contextWindowTokens: 1_000_000 };
    const loop = () => {
        const run = longContextToolLoopStep(limits);
        run.prepareStep({ steps: [], messages: base });
        return run;
    };
    assert.deepEqual(longContextToolLoopStep(limits).prepareStep({ steps: [], messages: base }), { maxOutputTokens: 10_000 });
    assert.deepEqual(loop().prepareStep({ steps: [used(200_000, 3_000)], messages: base }), { maxOutputTokens: 7_000 });
    // The fourth call is the last reserved one: no more tools.
    assert.deepEqual(
        loop().prepareStep({ steps: [used(200_000, 1_000), used(201_000, 1_000), used(202_000, 1_000)], messages: base }),
        { maxOutputTokens: 7_000, toolChoice: "none" }
    );
    // Review r-20261118-113741-eaa398: once the output is spent the loop stops
    // -- no call re-sends the prompt for a one-token answer -- and an
    // unreported step counts at the most it was allowed, so it spends it too.
    const spentRun = loop();
    assert.equal(spentRun.outputSpent({ steps: [used(200_000, 12_000)] }), true);
    assert.equal(spentRun.outputSpent({ steps: [used(200_000, 3_000)] }), false);
    assert.throws(() => loop().prepareStep({ steps: [used(200_000, 12_000)], messages: base }), /output_budget/);
    assert.equal(loop().outputSpent({ steps: [used(undefined, undefined)] }), true);
    // What the finished steps used, for a turn that stops at a limit.
    const counter = loop();
    counter.outputSpent({ steps: [used(200_000, 1_000), used(205_000, 2_000)] });
    assert.deepEqual(counter.spent(), { inputTokens: 405_000, outputTokens: 3_000, steps: 2 });
    // Review r-20261118-111248-a62933: the next prompt is measured from the
    // messages it sends, tool results included. Near the window, the step
    // answers; past the input reservation or the window, it is never sent.
    const narrow = { ...limits, contextWindowTokens: 230_000 };
    const near = longContextToolLoopStep(narrow);
    assert.deepEqual(near.prepareStep({ steps: [], messages: base }), { maxOutputTokens: 10_000 });
    const answer = near.prepareStep({ steps: [used(200_000, 1_000)], messages: grown(25_000) });
    assert.equal(answer.toolChoice, "none");
    assert.ok(answer.maxOutputTokens <= 5_000);
    const over = longContextToolLoopStep(narrow);
    over.prepareStep({ steps: [], messages: base });
    assert.throws(() => over.prepareStep({ steps: [used(200_000, 1_000)], messages: grown(40_000) }), LongContextToolLoopLimitError);
    const poor = longContextToolLoopStep({ ...limits, inputTokens: 420_000 });
    poor.prepareStep({ steps: [], messages: base });
    assert.throws(() => poor.prepareStep({ steps: [used(200_000, 1_000)], messages: grown(30_000) }), /input_budget/);
    // A step that may call a tool keeps room for the step after it.
    const roomy = longContextToolLoopStep({ ...limits, contextWindowTokens: 220_000 });
    const first = roomy.prepareStep({ steps: [], messages: base });
    assert.equal(first.toolChoice, undefined);
    assert.ok(first.maxOutputTokens <= 220_000 - 200_000 - 6_000 - 4_096);
    const route = readFileSync(new URL("../app/api/chat/route.ts", import.meta.url), "utf8");
    assert.match(route, /firstPromptTokens: Math\.max\(\s*0,\s*\(budget\.contextInputTokens \?\? budget\.inputTokens\) -\s*reservationOnlyInputTokens\s*\)/);
    assert.match(route, /\.\.\.\(lookupStep\?\.\(options\) \?\? \{\}\),\s*\.\.\.longContextLoopStep\.prepareStep\(options\),/);
    assert.match(route, /longContextLoopStep\.outputSpent,/);
    // Only where this application runs a tool loop: a native-search-only turn
    // keeps its one call and its own tool choice.
    assert.match(route, /\(artifactToolConfig \|\| appManagedSearchTool\) &&[\s\S]{0,200}toolLoopStepCap > 1 &&/);
    // A turn stopped at a limit records the calls it already made.
    assert.match(route, /const spent = longContextLoopStep\.spent\(\);\s*researchFailureUsage = \{\s*inputTokens: spent\.inputTokens,\s*outputTokens: spent\.outputTokens,\s*usageFromProvider: true,/);
    // The MCP loop counts an unreported step's output as the budget spent.
    assert.match(
        readFileSync(new URL("../lib/mcpConnectorChatTool.ts", import.meta.url), "utf8"),
        /steps\.some\(\(step\) => !Number\.isSafeInteger\(step\.usage\.outputTokens\)\)\s*\? outputCeiling/
    );
});

test("the installed SDK reports usage as the sum of all steps", () => {
    const types = readFileSync(new URL("../node_modules/ai/dist/index.d.ts", import.meta.url), "utf8");
    const result = types.slice(types.indexOf("interface StreamTextResult"));
    const before = result.slice(0, result.indexOf("readonly usage: PromiseLike<LanguageModelUsage>;"));
    // The doc comment that belongs to `usage` itself: the block that ends
    // right before the declaration, with nothing but whitespace between.
    const end = before.lastIndexOf("*/");
    assert.match(before.slice(end + 2), /^\s*$/);
    const doc = before.slice(before.lastIndexOf("/**", end), end);
    assert.match(doc, /When there are multiple steps, the usage is the sum of all step usages\./);
});

// Review r-20261118-095524-6e67a5: a partial step list never prices a turn.
test("per-call pricing is used only when the calls account for the whole usage", () => {
    const long = resolveModelPricing(getModel("gpt-6-luna"), { estimatedPromptTokens: 300_000 });
    const snapshot = {
        modelId: "gpt-6-luna",
        inputUsdPerMillionTokens: long.inputUsdPerMillionTokens,
        outputUsdPerMillionTokens: long.outputUsdPerMillionTokens,
        longContextThresholdTokens: 272_000,
        pricingVersion: long.pricingVersion,
        costSource: long.costSource,
        providerCallPasses: 2,
    };
    const calls = [
        { inputTokens: 230_000, outputTokens: 1_000 },
        { inputTokens: 240_000, outputTokens: 1_000 },
    ];
    const totals = { inputTokens: 470_000, outputTokens: 2_000 };
    const covered = longContextSettledUsageCost(snapshot, totals, calls);
    // A turn settled on its reservation estimate, or with an uncounted step:
    // the totals, by the summed-input rule (kept at the reserved long rate).
    const estimate = { inputTokens: 600_000, outputTokens: 8_000 };
    const onTotals = longContextSettledUsageCost(snapshot, estimate, calls);
    const expected = longContextSettledUsageCost(snapshot, estimate);
    assert.equal(onTotals.totalCostMicroUsd, expected.totalCostMicroUsd);
    assert.ok(onTotals.totalCostMicroUsd > covered.totalCostMicroUsd);
    assert.equal(
        longContextSettlementRates(snapshot, 600_000, calls).inputUsdPerMillionTokens,
        long.inputUsdPerMillionTokens
    );
    // The route hands over steps only when every step was counted.
    const route = readFileSync(new URL("../app/api/chat/route.ts", import.meta.url), "utf8");
    assert.match(route, /!steps\.every\(\s*\(step\) => counted\(step\.usage\.inputTokens\) && counted\(step\.usage\.outputTokens\)\s*\)/);
});

// Review r-20261118-083641-09ae82: without per-step usage (an attempt replaced
// by a fallback), a multi-call total is a sum of prompts. A sum under a
// boundary puts every call under it, so it may lower the tier; a sum over one
// says nothing about any call, so the reserved tier stands.
test("without per-step usage a multi-call reservation only ever settles at a lower tier", () => {
    const short = resolveModelPricing(getModel("gpt-6-luna"), { estimatedPromptTokens: 1_000 });
    const long = resolveModelPricing(getModel("gpt-6-luna"), { estimatedPromptTokens: 300_000 });
    const base = {
        modelId: "gpt-6-luna",
        pricingVersion: short.pricingVersion,
        costSource: short.costSource,
        providerCallPasses: 4,
    };
    const reservedShort = {
        ...base,
        inputUsdPerMillionTokens: short.inputUsdPerMillionTokens,
        outputUsdPerMillionTokens: short.outputUsdPerMillionTokens,
        longContextThresholdTokens: null,
    };
    // Four 200k calls sum to 800k: still the short rate.
    assert.equal(longContextSettlementRates(reservedShort, 800_000), reservedShort);
    const reservedLong = {
        ...base,
        inputUsdPerMillionTokens: long.inputUsdPerMillionTokens,
        outputUsdPerMillionTokens: long.outputUsdPerMillionTokens,
        longContextThresholdTokens: 272_000,
    };
    assert.equal(
        longContextSettlementRates(reservedLong, 230_000).inputUsdPerMillionTokens,
        short.inputUsdPerMillionTokens
    );
    assert.equal(longContextSettlementRates(reservedLong, 800_000), reservedLong);
    // One call: the sum is the prompt, and it raises as before.
    const single = { ...reservedShort, providerCallPasses: null };
    assert.equal(
        longContextSettlementRates(single, 300_000).inputUsdPerMillionTokens,
        long.inputUsdPerMillionTokens
    );
});

// Review r-20261118-102103-16e00a, operator decision 2026-11-18: a long-context
// turn reserves every call its application tool loop may make, and the loop
// stops at what was reserved.
test("a long-context turn reserves every call of its tool loop, and only then", () => {
    const luna = getModel("gpt-6-luna");
    const long = 200_000;
    const withLoop = createChatBudget("user", luna, long, { longContextToolInputPasses: 8 });
    assert.equal(withLoop.providerCallPasses, 4);
    const without = createChatBudget("user", luna, long);
    assert.equal(without.providerCallPasses, undefined);
    assert.ok(withLoop.usageCredits > without.usageCredits);
    assert.ok(withLoop.inputTokens > without.inputTokens * 3);
    // An ordinary turn is reserved exactly as before.
    const ordinary = createChatBudget("user", luna, 1_000, { longContextToolInputPasses: 8 });
    assert.equal(ordinary.providerCallPasses, undefined);
    assert.equal(ordinary.usageCredits, createChatBudget("user", luna, 1_000).usageCredits);
    const route = readFileSync(new URL("../app/api/chat/route.ts", import.meta.url), "utf8");
    assert.match(route, /longContextToolInputPasses: Math\.max\(\s*artifactToolPlan\?\.registerTool \? GENERATED_ARTIFACT_MAX_STEPS : 1,\s*appManagedSearchEnabled && webSearchCapability\.searchBackend\s*\? APP_MANAGED_SEARCH_MAX_STEPS\s*: 1\s*\)/);
    assert.match(route, /budget\.longContextSettlement && !isResearchPreview\s*\? \(budget\.providerCallPasses \?\? 1\)\s*: Number\.POSITIVE_INFINITY/);
    assert.match(route, /stepCountIs\(\s*Math\.min\(APP_MANAGED_SEARCH_MAX_STEPS, toolLoopStepCap\)\s*\)/);
    assert.match(route, /: GENERATED_ARTIFACT_MAX_STEPS,\s*toolLoopStepCap\s*\)\s*\)/);
});

test("the call count travels from the budget to every settlement path", () => {
    const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
    const security = read("lib/chatSecurity.ts");
    assert.match(security, /\.\.\.\(passes > 1 \? \{ providerCallPasses: passes \} : \{\}\),/);
    assert.match(security, /providerCallPasses: z\.number\(\)\.int\(\)\.min\(2\)\.max\(4\)\.optional\(\),/);
    assert.equal(security.match(/providerCallPasses: canonical\.providerCallPasses \?\? null,/g)?.length, 2);
    const route = read("app/api/chat/route.ts");
    assert.match(route, /providerCallPasses: budget\.providerCallPasses \?\? null,/);
    assert.match(route, /providerCallPasses: plan\.budget\.providerCallPasses \?\? null,/);
    const luna = getModel("gpt-6-luna");
    assert.equal(createChatBudget("user", luna, 1_000).providerCallPasses, undefined);
    assert.equal(
        createChatBudget("user", luna, 1_000, { toolInputPasses: 3 }).providerCallPasses,
        3
    );
});

// Review r-20261118-083641-09ae82 (cursor): the image allowance is reserved,
// never sent, so it takes no room from the answer.
test("the window room counts what is sent, not the image allowance", () => {
    const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
    assert.match(
        read("lib/chatSecurity.ts"),
        /model\.contextWindowTokens! -\s*\(contextInputTokens - reservationOnlyInputTokens\)/
    );
    assert.match(
        read("app/api/chat/route.ts"),
        /reservedInputTokens: Math\.max\(0, contextInputTokens - reservationOnlyInputTokens\),/
    );
});

// Same review (nit): a profile can change its cached-input multiplier at a
// boundary (Qwen 3.7 Plus, 0.2 to 1.0 above 256K); it moves with the tier.
test("the cached-input multiplier moves with the settled tier", () => {
    const short = resolveModelPricing(getModel("qwen3.7-plus"), { estimatedPromptTokens: 1_000 });
    const snapshot = {
        modelId: "qwen3.7-plus",
        inputUsdPerMillionTokens: short.inputUsdPerMillionTokens,
        outputUsdPerMillionTokens: short.outputUsdPerMillionTokens,
        cachedInputPriceMultiplier: short.cachedInputPriceMultiplier,
        longContextThresholdTokens: null,
        pricingVersion: short.pricingVersion,
        costSource: short.costSource,
    };
    assert.equal(snapshot.cachedInputPriceMultiplier, 0.2);
    const raised = longContextSettlementRates(snapshot, 300_000);
    assert.equal(raised.cachedInputPriceMultiplier, 1);
    assert.equal(raised.longContextThresholdTokens, 256_000);
    const lowered = longContextSettlementRates(raised, 200_000);
    assert.equal(lowered.cachedInputPriceMultiplier, 0.2);
    assert.equal(lowered.inputUsdPerMillionTokens, short.inputUsdPerMillionTokens);
});

// Review r-20261118-045351-43dc45: the correction never rewrites a price the
// reservation did not take from the tiers in force.
test("a reservation under another price version is settled exactly as reserved", () => {
    const short = resolveModelPricing(getModel("gpt-6-luna"), { estimatedPromptTokens: 1_000 });
    const snapshot = {
        modelId: "gpt-6-luna",
        inputUsdPerMillionTokens: short.inputUsdPerMillionTokens,
        outputUsdPerMillionTokens: short.outputUsdPerMillionTokens,
        longContextThresholdTokens: null,
        costSource: short.costSource,
    };
    for (const pricingVersion of ["openai-gpt-6-luna-1999-01-01", null, undefined]) {
        const stale = { ...snapshot, pricingVersion };
        assert.equal(longContextSettlementRates(stale, 300_000), stale, String(pricingVersion));
    }
});

test("a flat or fallback price is settled exactly as reserved", () => {
    const short = resolveModelPricing(getModel("gpt-6-luna"), { estimatedPromptTokens: 1_000 });
    for (const costSource of [
        "model_registry_override",
        "registry_env_override",
        "conservative_fallback",
        "conservative_fallback_env_override",
        null,
    ]) {
        const flat = {
            modelId: "gpt-6-luna",
            inputUsdPerMillionTokens: 0.1,
            outputUsdPerMillionTokens: 0.5,
            longContextThresholdTokens: null,
            pricingVersion: short.pricingVersion,
            costSource,
        };
        assert.equal(longContextSettlementRates(flat, 300_000), flat, String(costSource));
    }
});

test("every settlement path applies the same long-context rule", () => {
    const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
    assert.match(read("lib/chatSecurity.ts"), /longContextSettledUsageCost\(/);
    assert.match(read("lib/chatMultiAttemptSettlement.ts"), /longContextSettledUsageCost\(/);
    assert.match(read("lib/chatAttemptCostLedger.ts"), /longContextSettledUsageCost\(/);
    assert.match(
        read("app/api/chat/route.ts"),
        /longContextThresholdTokens: budget\.longContextThresholdTokens,\s*costSource: budget\.costSource \?\? null,\s*\} satisfies AttemptPriceSnapshot/
    );
    const single = read("lib/chatSecurity.ts");
    assert.match(single, /pricingVersion: canonical\.pricingVersion \?\? null,\s*costSource: canonical\.costSource \?\? null,/);
});

// Review, major: earlier files share half of this model's limit, not of 128k.
test("the earlier-files share follows the model's account limit", () => {
    const route = readFileSync(new URL("../app/api/chat/route.ts", import.meta.url), "utf8");
    const start = route.indexOf("const pastAttachmentTokenBudget = pastTurnAttachmentTokenBudget(");
    assert.ok(start > 0);
    const call = route.slice(start, route.indexOf(");", start));
    assert.match(call, /accountChatMaxInputTokens\(modelConfig\)/);
    assert.doesNotMatch(call, /chatUserMaxInputTokens/);
});

test("guests are untouched", () => {
    const guest = getModel("gpt-5-6-luna");
    assert.throws(() => createChatBudget("guest", guest, 16_001), /token budget/i);
});
