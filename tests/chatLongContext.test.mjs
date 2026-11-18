import assert from "node:assert/strict";
import test from "node:test";
import {
    CHAT_LONG_CONTEXT_MICRO_USD_PER_CREDIT_DEFAULT,
    CHAT_USER_MAX_INPUT_TOKENS_DEFAULT,
    chatAccountMaxInputTokens,
    chatLongContextCostCredits,
} from "../lib/chatInputLimits.ts";
import { createChatBudget } from "../lib/chatSecurity.ts";
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

const tokenCostMicroUsd = (budget) =>
    Math.ceil(budget.inputTokens * budget.inputUsdPerMillionTokens) +
    Math.ceil(budget.reservedOutputTokens * budget.outputUsdPerMillionTokens) +
    budget.promptCacheWriteReservedPremiumMicroUsd;

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

test("guests are untouched", () => {
    const guest = getModel("gpt-5-6-luna");
    assert.throws(() => createChatBudget("guest", guest, 16_001), /token budget/i);
});
