import assert from "node:assert/strict";
import test from "node:test";

import { AVAILABLE_MODELS } from "../lib/models.ts";
import {
  createChatBudget,
  getChatBudgetReservedCostMicroUsd,
} from "../lib/chatSecurity.ts";
import { ANTHROPIC_PROMPT_CACHE_TTL } from "../lib/anthropicPromptCaching.ts";
import { calculateProviderUsageCost } from "../lib/providerUsageCost.ts";

/**
 * The reservation half of Anthropic prompt caching.
 *
 * A cache-marked request may, in the worst case, write its entire prompt into
 * the cache at 1.25x the base input rate -- which is exactly what an ordinary
 * first turn does. If the provider budget has not authorised that 0.25x
 * premium before dispatch, it is discovered at settlement, which is after the
 * money is spent. See docs/policy/anthropic-prompt-caching.md §5.
 *
 * The other half of the contract is what this must *not* touch: the premium is
 * operational, and `usageCredits` is entitlement. Charging a user's credits for
 * Tomverse's cache-creation cost is the hidden USD ceiling that
 * docs/policy/credit-and-cost-limits.md exists to keep out of the credit layer.
 */

const model = (modelId) => {
  const found = AVAILABLE_MODELS.find((candidate) => candidate.id === modelId);
  assert.ok(found, `model ${modelId} is missing from the registry`);
  return found;
};

const INPUT_TOKENS = 20_000;

const budgetFor = (modelId, options) =>
  createChatBudget("user", model(modelId), INPUT_TOKENS, options);

test("a cached Anthropic turn reserves the 0.25x cache-write premium", () => {
  const cached = budgetFor("claude-sonnet-5", { promptCachePath: "chat_turn" });
  const uncached = budgetFor("claude-sonnet-5");

  assert.equal(uncached.promptCacheWriteReservedPremiumMicroUsd, 0);
  assert.ok(
    cached.promptCacheWriteReservedPremiumMicroUsd > 0,
    "a cache-marked turn must reserve the premium"
  );

  // The premium is (writeRate - inputRate) x reserved input tokens: the same
  // tokens are already reserved at the base rate, so reserving the whole write
  // cost on top would double-count the base.
  const premiumRate =
    cached.cacheWriteUsdPerMillionTokens - cached.inputUsdPerMillionTokens;
  // A USD-per-million-token rate is numerically equal to micro-USD per token,
  // which is why there is no division here and none anywhere else in this
  // ledger's arithmetic.
  assert.equal(
    cached.promptCacheWriteReservedPremiumMicroUsd,
    Math.ceil(cached.inputTokens * premiumRate),
    "premium = (write rate - input rate) x reserved input tokens"
  );

  // And it reaches the number the guardrail actually spends against.
  assert.equal(
    getChatBudgetReservedCostMicroUsd(cached) -
      getChatBudgetReservedCostMicroUsd(uncached),
    cached.promptCacheWriteReservedPremiumMicroUsd
  );
});

test("the reservation covers the worst case a settlement can produce", () => {
  // The worst case is the whole reserved prompt written at 1.25x. Anything the
  // provider actually does is a subset of that, so the reservation must not be
  // exceeded by it -- an under-reservation is a request that was let through
  // without the money for it.
  const cached = budgetFor("claude-sonnet-5", { promptCachePath: "chat_turn" });
  const worstCase = calculateProviderUsageCost({
    inputTokens: cached.inputTokens,
    cacheWriteInputTokens: cached.inputTokens,
    outputTokens: cached.reservedOutputTokens,
    inputUsdPerMillionTokens: cached.inputUsdPerMillionTokens,
    outputUsdPerMillionTokens: cached.outputUsdPerMillionTokens,
    cachedInputPriceMultiplier: cached.cachedInputPriceMultiplier,
    cacheWriteUsdPerMillionTokens: cached.cacheWriteUsdPerMillionTokens,
  });

  assert.ok(
    worstCase.totalCostMicroUsd <= getChatBudgetReservedCostMicroUsd(cached),
    `settled worst case ${worstCase.totalCostMicroUsd} exceeded the reservation ${getChatBudgetReservedCostMicroUsd(cached)}`
  );

  // An uncached reservation would not have covered it -- which is the whole
  // point of adding the premium rather than trusting the existing headroom.
  const uncached = budgetFor("claude-sonnet-5");
  assert.ok(
    worstCase.totalCostMicroUsd > getChatBudgetReservedCostMicroUsd(uncached),
    "without the premium the reservation would have been short"
  );
});

test("a steady cached turn settles below its reservation and is refunded down", () => {
  const cached = budgetFor("claude-sonnet-5", { promptCachePath: "chat_turn" });
  // The ordinary case: most of the prefix read back, a small delta written.
  const settled = calculateProviderUsageCost({
    inputTokens: cached.inputTokens,
    cachedInputTokens: Math.floor(cached.inputTokens * 0.9),
    cacheWriteInputTokens: Math.floor(cached.inputTokens * 0.08),
    outputTokens: cached.reservedOutputTokens,
    inputUsdPerMillionTokens: cached.inputUsdPerMillionTokens,
    outputUsdPerMillionTokens: cached.outputUsdPerMillionTokens,
    cachedInputPriceMultiplier: cached.cachedInputPriceMultiplier,
    cacheWriteUsdPerMillionTokens: cached.cacheWriteUsdPerMillionTokens,
  });
  assert.ok(
    settled.totalCostMicroUsd < getChatBudgetReservedCostMicroUsd(cached),
    "a steady cached turn must settle under its reservation"
  );
});

test("the premium never touches user entitlement", () => {
  const cached = budgetFor("claude-sonnet-5", { promptCachePath: "chat_turn" });
  const uncached = budgetFor("claude-sonnet-5");
  assert.equal(
    cached.usageCredits,
    uncached.usageCredits,
    "credits are weighted by the conversation the user sent; a cache write is Tomverse's cost at Anthropic and must not narrow their entitlement"
  );
});

test("a non-Anthropic model reserves no premium even when given a caching path", () => {
  // MiniMax shares the Anthropic SDK namespace and must not share its caching
  // costs. If it ever reserved a premium, the budget and the request would be
  // disagreeing about whether a marker was sent.
  const minimax = budgetFor("minimax-m3", { promptCachePath: "chat_turn" });
  assert.equal(minimax.promptCacheWriteReservedPremiumMicroUsd, 0);
  assert.equal(minimax.promptCacheTtl, undefined);
});

test("a one-shot path reserves no premium", () => {
  const title = budgetFor("claude-sonnet-5", {
    promptCachePath: "conversation_title",
  });
  assert.equal(title.promptCacheWriteReservedPremiumMicroUsd, 0);
});

test("the reserved rate is carried onto the budget for settlement to reuse", () => {
  const cached = budgetFor("claude-sonnet-5", { promptCachePath: "chat_turn" });
  // 1.25x US$2 = US$2.50, from Anthropic's published table.
  assert.equal(cached.cacheWriteUsdPerMillionTokens, 2.5);
  assert.equal(ANTHROPIC_PROMPT_CACHE_TTL, "5m");
});

test("the cost intent records the premium so the payload's own check can reconstruct it", async () => {
  // The defect this pins. `reservedCostMicroUsd` on an attempt cost intent is
  // validated on every read against the sum of its components, and adding the
  // premium to the reservation without adding it here made that sum disagree
  // by exactly the premium -- so `deserializeReservation` refused, and every
  // cached turn with a native search failed to settle at all. Caught by
  // tests/integration/chat-route-search-settlement.db.test.ts; pinned here
  // because this is where the arithmetic lives and it needs no database.
  const { attemptCostIntentProblems } = await import(
    "../lib/chatProviderHolds.ts"
  );

  const inputTokens = 20_000;
  const reservedOutputTokens = 2_048;
  const inputRate = 2;
  const outputRate = 10;
  const premium = 10_000;
  const searchReserved = 50_000;
  const tokens =
    Math.ceil(inputTokens * inputRate) +
    Math.ceil(reservedOutputTokens * outputRate);

  const intent = (overrides = {}) => ({
    attemptIndex: 0,
    modelId: "claude-sonnet-5",
    provider: "anthropic",
    estimatedInputTokens: inputTokens,
    reservedOutputTokens,
    inputUsdPerMillionTokens: inputRate,
    outputUsdPerMillionTokens: outputRate,
    cachedInputPriceMultiplier: 0.1,
    reservedCostMicroUsd: tokens + searchReserved + premium,
    nativeSearchAuthorization: {
      reservedCostMicroUsd: searchReserved,
      costPerQueryMicroUsd: 10_000,
      maxQueries: 5,
    },
    promptCacheWriteReservedPremiumMicroUsd: premium,
    ...overrides,
  });

  const holds = [
    { attemptIndex: 0, key: "provider:anthropic", period: "provider-cost-day", periodStart: new Date(0), amount: 1 },
    { attemptIndex: 0, key: "provider:anthropic", period: "provider-cost-month", periodStart: new Date(0), amount: 1 },
  ];

  assert.deepEqual(
    attemptCostIntentProblems({ holds, intents: [intent()] }),
    [],
    "an intent that records its premium must reconcile"
  );

  // Drop the premium from the record while leaving it in the total: the exact
  // shape of the defect, and it must be refused rather than settled.
  const problems = attemptCostIntentProblems({
    holds,
    intents: [intent({ promptCacheWriteReservedPremiumMicroUsd: undefined })],
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /prompt-cache write premium/);

  // An uncached turn is unchanged: no premium recorded, none in the total.
  assert.deepEqual(
    attemptCostIntentProblems({
      holds,
      intents: [
        intent({
          promptCacheWriteReservedPremiumMicroUsd: undefined,
          reservedCostMicroUsd: tokens + searchReserved,
        }),
      ],
    }),
    []
  );
});
