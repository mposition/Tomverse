import assert from "node:assert/strict";
import test from "node:test";

import {
  MULTI_ATTEMPT_SETTLEMENT_VERSION,
  attemptSetProblems,
  combineAttemptUsage,
} from "../lib/chatMultiAttemptSettlement.ts";

// Routing policy §7 keeps two ledgers apart, and every assertion here is about
// one of them staying out of the other's way:
//
//   provider cost = every attempt, at its own provider's rates
//   user charge   = one accepted attempt, and never more than one

const price = (provider, modelId, input, output) => ({
  provider,
  modelId,
  inputUsdPerMillionTokens: input,
  outputUsdPerMillionTokens: output,
  cachedInputPriceMultiplier: 1,
  pricingVersion: "test-v1",
});

const attempt = (overrides = {}) => ({
  attemptIndex: 0,
  price: price("openai", "gpt-5-6-luna", 1, 10),
  inputTokens: 1_000_000,
  cachedInputTokens: 0,
  outputTokens: 1_000_000,
  usageFromProvider: true,
  outcome: "completed",
  ...overrides,
});

test("each attempt is priced at its own provider's rates, not the primary's", () => {
  const combined = combineAttemptUsage([
    attempt({ attemptIndex: 0, outcome: "failed", outputTokens: 0 }),
    attempt({
      attemptIndex: 1,
      price: price("google", "gemini-4-pro", 5, 50),
      outcome: "completed",
    }),
  ]);

  // 1M input at $1/M = 1_000_000 micro-USD; the fallback's own rates give
  // 5_000_000 + 50_000_000. Priced at the primary's they would be 11_000_000.
  assert.equal(combined.attempts[0].costMicroUsd, 1_000_000);
  assert.equal(combined.attempts[1].costMicroUsd, 55_000_000);
  assert.equal(combined.providerCostMicroUsd, 56_000_000);
});

test("each provider's spend is kept apart, because each has its own budget", () => {
  const combined = combineAttemptUsage([
    attempt({ attemptIndex: 0, outcome: "failed", outputTokens: 0 }),
    attempt({
      attemptIndex: 1,
      price: price("google", "gemini-4-pro", 5, 50),
    }),
  ]);
  assert.deepEqual([...combined.costByProvider], [
    ["openai", 1_000_000],
    ["google", 55_000_000],
  ]);
});

test("two attempts on one provider sum into that provider's figure", () => {
  const combined = combineAttemptUsage([
    attempt({ attemptIndex: 0, outcome: "failed", outputTokens: 0 }),
    attempt({ attemptIndex: 1, price: price("openai", "gpt-5-6-mini", 1, 10) }),
  ]);
  assert.deepEqual([...combined.costByProvider], [["openai", 12_000_000]]);
});

// The rule a fallback is most likely to break.
test("the user is charged from exactly one attempt, whatever the outcomes", () => {
  const outcomes = ["completed", "cancelled", "failed", "empty"];
  for (const first of outcomes) {
    for (const second of outcomes) {
      const combined = combineAttemptUsage([
        attempt({ attemptIndex: 0, outcome: first }),
        attempt({ attemptIndex: 1, outcome: second }),
      ]);
      const billed = combined.attempts.filter((entry) => entry.userBilled);
      assert.equal(billed.length, 1, `${first} then ${second}`);
      assert.equal(billed[0], combined.billedAttempt);
    }
  }
});

test("the accepted attempt is the one the user pays for", () => {
  const combined = combineAttemptUsage([
    attempt({ attemptIndex: 0, outcome: "failed" }),
    attempt({ attemptIndex: 1, price: price("google", "gemini-4-pro", 5, 50) }),
  ]);
  assert.equal(combined.billedAttempt.attemptIndex, 1);
  assert.equal(combined.billedAttempt.price.modelId, "gemini-4-pro");
});

test("an empty answer still arrived, so it is what the user is charged for", () => {
  const combined = combineAttemptUsage([
    attempt({ attemptIndex: 0, outcome: "failed" }),
    attempt({ attemptIndex: 1, outcome: "empty", outputTokens: 0 }),
  ]);
  assert.equal(combined.billedAttempt.attemptIndex, 1);
  assert.equal(combined.outcome, "empty");
});

test("when nothing was accepted the user is charged for the last attempt only", () => {
  // Not the sum. A user should not pay more because Tomverse chose to retry.
  const combined = combineAttemptUsage([
    attempt({ attemptIndex: 0, outcome: "failed" }),
    attempt({ attemptIndex: 1, outcome: "failed" }),
  ]);
  assert.equal(combined.billedAttempt.attemptIndex, 1);
  assert.equal(combined.attempts.filter((entry) => entry.userBilled).length, 1);
  // The provider ledger still carries both, which is the half §7 says must
  // not be rewritten.
  assert.equal(combined.providerCostMicroUsd, 22_000_000);
});

test("a failed primary before a successful fallback is a successful response", () => {
  // §10's dashboards read this. A turn the user got an answer to must not
  // appear in the failure numbers because the first model stumbled.
  const combined = combineAttemptUsage([
    attempt({ attemptIndex: 0, outcome: "failed" }),
    attempt({ attemptIndex: 1, outcome: "completed" }),
  ]);
  assert.equal(combined.outcome, "completed");
});

test("a provider that reports its own cost is believed, for its attempt only", () => {
  const combined = combineAttemptUsage([
    attempt({
      attemptIndex: 0,
      price: price("perplexity", "sonar-pro", 1, 10),
      providerReportedCostMicroUsd: 7_777,
      outcome: "failed",
    }),
    attempt({ attemptIndex: 1 }),
  ]);
  assert.equal(combined.attempts[0].costMicroUsd, 7_777);
  assert.equal(combined.attempts[0].costSource, "provider_response");
  // The estimate still stands where nothing was reported.
  assert.equal(combined.attempts[1].costSource, "token_estimate");
  assert.equal(combined.attempts[1].costMicroUsd, 11_000_000);
});

test("a search's own per-call cost lands on the attempt that made it", () => {
  const combined = combineAttemptUsage([
    attempt({ attemptIndex: 0, outcome: "failed", searchCostMicroUsd: 25_000 }),
    attempt({ attemptIndex: 1 }),
  ]);
  assert.equal(combined.attempts[0].costMicroUsd, 11_000_000 + 25_000);
  assert.equal(combined.attempts[1].costMicroUsd, 11_000_000);
});

test("cached input is priced at its own multiplier per attempt", () => {
  const combined = combineAttemptUsage([
    attempt({
      attemptIndex: 0,
      cachedInputTokens: 1_000_000,
      outputTokens: 0,
      price: { ...price("openai", "gpt-5-6-luna", 1, 10), cachedInputPriceMultiplier: 0.1 },
    }),
  ]);
  assert.equal(combined.attempts[0].costMicroUsd, 100_000);
});

test("one attempt combines to exactly what one attempt cost", () => {
  // The single-attempt shape has to keep working: it is what every turn until
  // now has been, and the fallback path must not have redefined it.
  const combined = combineAttemptUsage([attempt()]);
  assert.equal(combined.providerCostMicroUsd, 11_000_000);
  assert.equal(combined.billedAttempt.attemptIndex, 0);
  assert.equal(combined.attempts[0].userBilled, true);
  assert.equal(combined.version, MULTI_ATTEMPT_SETTLEMENT_VERSION);
});

// These are the sets that would settle silently wrong rather than loudly.
test("a duplicate attempt index is refused, not deduplicated", () => {
  const problems = attemptSetProblems([
    attempt({ attemptIndex: 0 }),
    attempt({ attemptIndex: 0 }),
  ]);
  assert.equal(problems.length > 0, true);
  assert.match(problems.join(" "), /share an attemptIndex/);
});

test("a gap in the indexes means an attempt was lost between dispatch and here", () => {
  const problems = attemptSetProblems([
    attempt({ attemptIndex: 0 }),
    attempt({ attemptIndex: 2 }),
  ]);
  assert.match(problems.join(" "), /0\.\.n with no gaps/);
});

test("a third attempt is a policy breach, and the money is where it shows", () => {
  const problems = attemptSetProblems([
    attempt({ attemptIndex: 0 }),
    attempt({ attemptIndex: 1 }),
    attempt({ attemptIndex: 2 }),
  ]);
  assert.match(problems.join(" "), /exceeds the 2-attempt budget/);
});

test("an empty set has nothing to settle", () => {
  assert.equal(attemptSetProblems([]).length, 1);
});

test("the ordinary one- and two-attempt sets are accepted", () => {
  assert.deepEqual(attemptSetProblems([attempt()]), []);
  assert.deepEqual(
    attemptSetProblems([attempt({ attemptIndex: 0 }), attempt({ attemptIndex: 1 })]),
    []
  );
});
