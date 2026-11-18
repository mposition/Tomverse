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
import { accountChatMaxInputTokens, createChatBudget } from "../lib/chatSecurity.ts";
import { longContextSettlementRates, resolveModelPricing } from "../lib/modelPricing.ts";
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
    assert.ok(budget.maxOutputTokens > budget.reservedOutputTokens);
    assert.equal(budget.usageCredits, Math.ceil(tokenCostMicroUsd(budget) / RATE));
    assert.deepEqual(budget.longContextSettlement, {
        microUsdPerCredit: RATE,
        floorCredits: getWeightedUsageCredits(luna, 200_000),
    });
    assert.equal(createChatBudget("user", luna, FLAT).longContextSettlement, null);
});

test("settlement charges the actual cost, between the flat floor and the flat rule", () => {
    const settlement = { microUsdPerCredit: RATE, floorCredits: 9 };
    const settle = (flatSettledCredits, tokenCostMicroUsd, searchSurchargeCredits = 0) =>
        chatLongContextSettledCredits({ settlement, flatSettledCredits, tokenCostMicroUsd, searchSurchargeCredits });
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
        chatLongContextSettledCredits({ settlement: null, flatSettledCredits: 24, tokenCostMicroUsd: 9e9, searchSurchargeCredits: 0 }),
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

test("settlement records a crossed tier at the higher rate, never a lower one", () => {
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
    assert.match(read("lib/chatSecurity.ts"), /longContextSettlementRates\(/);
    assert.match(read("lib/chatMultiAttemptSettlement.ts"), /longContextSettlementRates\(attempt\.price, attempt\.inputTokens\)/);
    assert.match(read("lib/chatAttemptCostLedger.ts"), /longContextSettlementRates\(/);
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
