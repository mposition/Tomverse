import assert from "node:assert/strict";
import test from "node:test";

import {
  attemptCostIntentProblems,
  costIntentFor,
  deriveProviderEntries,
  providerHoldProblems,
  withoutAttemptHolds,
} from "../lib/chatProviderHolds.ts";

// The arithmetic that keeps two attempts' holds on one provider tellable
// apart. Every failure here is money moving without authorization, so most of
// these are about what the validator refuses.

const day = new Date("2026-08-14T00:00:00.000Z");
const month = new Date("2026-08-01T00:00:00.000Z");

const hold = (attemptIndex, provider, period, amount) => ({
  attemptIndex,
  key: `provider:${provider}`,
  period: `provider-cost-${period}`,
  periodStart: period === "day" ? day : month,
  amount,
});

const pair = (attemptIndex, provider, amount) => [
  hold(attemptIndex, provider, "day", amount),
  hold(attemptIndex, provider, "month", amount),
];

test("two attempts on one provider add up to one entry", () => {
  // Two rows under one key would each be settled to that provider's whole
  // actual cost, so the provider would be paid twice for one turn.
  const entries = deriveProviderEntries([
    ...pair(0, "openai", 100),
    ...pair(1, "openai", 40),
  ]);
  assert.equal(entries.length, 2);
  assert.deepEqual(
    entries.map((entry) => [entry.period, entry.amount]),
    [
      ["provider-cost-day", 140],
      ["provider-cost-month", 140],
    ]
  );
});

test("two providers keep their own entries", () => {
  const entries = deriveProviderEntries([
    ...pair(0, "openai", 100),
    ...pair(1, "google", 40),
  ]);
  assert.equal(entries.length, 4);
  assert.deepEqual(
    entries.filter((entry) => entry.key === "provider:google").map((e) => e.amount),
    [40, 40]
  );
});

test("the derived order is stable, so an unchanged payload serializes the same", () => {
  const a = deriveProviderEntries([...pair(0, "openai", 100), ...pair(1, "google", 40)]);
  const b = deriveProviderEntries([...pair(1, "google", 40), ...pair(0, "openai", 100)]);
  assert.deepEqual(a, b);
});

test("releasing one attempt leaves the other's hold on a shared provider", () => {
  // The reason release takes an index and not a provider.
  const holds = [...pair(0, "openai", 100), ...pair(1, "openai", 40)];
  const entries = deriveProviderEntries(withoutAttemptHolds(holds, 1));
  assert.deepEqual(
    entries.map((entry) => entry.amount),
    [100, 100]
  );
});

test("releasing an attempt that holds nothing changes nothing", () => {
  const holds = pair(0, "openai", 100);
  assert.deepEqual(withoutAttemptHolds(holds, 1), holds);
});

const entriesFor = (holds) => deriveProviderEntries(holds);

test("holds that agree with their entries are accepted", () => {
  const holds = [...pair(0, "openai", 100), ...pair(1, "google", 40)];
  assert.deepEqual(providerHoldProblems({ holds, entries: entriesFor(holds) }), []);
});

test("an entry above its holds is refused", () => {
  // It would release budget nobody reserved.
  const holds = pair(0, "openai", 100);
  const entries = entriesFor(holds).map((entry) => ({ ...entry, amount: 500 }));
  const problems = providerHoldProblems({ holds, entries });
  assert.match(problems.join(" "), /holds 500 but its attempts add to 100/);
});

test("an entry below its holds is refused", () => {
  // It would leave a provider holding money for a call that finished.
  const holds = pair(0, "openai", 100);
  const entries = entriesFor(holds).map((entry) => ({ ...entry, amount: 10 }));
  assert.match(
    providerHoldProblems({ holds, entries }).join(" "),
    /holds 10 but its attempts add to 100/
  );
});

test("a hold with no entry to settle it is refused", () => {
  const holds = [...pair(0, "openai", 100), ...pair(1, "google", 40)];
  const entries = entriesFor(pair(0, "openai", 100));
  assert.match(
    providerHoldProblems({ holds, entries }).join(" "),
    /held by an attempt and no entry to settle it/
  );
});

test("an entry no attempt holds is refused", () => {
  const holds = pair(0, "openai", 100);
  const entries = [...entriesFor(holds), ...entriesFor(pair(1, "google", 40))];
  assert.match(
    providerHoldProblems({ holds, entries }).join(" "),
    /is held by no attempt/
  );
});

test("errors that cancel out in a sum are still two errors", () => {
  // Compared bucket by bucket for exactly this reason.
  const holds = [...pair(0, "openai", 100), ...pair(1, "google", 40)];
  const entries = entriesFor(holds).map((entry) =>
    entry.key === "provider:openai"
      ? { ...entry, amount: 60 }
      : { ...entry, amount: 80 }
  );
  const problems = providerHoldProblems({ holds, entries });
  assert.equal(problems.length, 4, problems.join(" | "));
});

test("one attempt holding a bucket twice is refused", () => {
  const holds = [...pair(0, "openai", 100), hold(0, "openai", "day", 5)];
  assert.match(
    providerHoldProblems({ holds, entries: entriesFor(holds) }).join(" "),
    /holds provider:openai\/provider-cost-day twice/
  );
});

test("an attempt index outside the build budget is refused", () => {
  for (const index of [-1, 2, 7]) {
    const holds = pair(index, "openai", 100);
    assert.match(
      providerHoldProblems({ holds, entries: entriesFor(holds) }).join(" "),
      /outside the 0\.\.1 build budget/,
      String(index)
    );
  }
});

test("a non-provider key or unknown period is refused", () => {
  const strange = [
    { ...hold(0, "openai", "day", 10), key: "user:someone" },
    { ...hold(0, "openai", "day", 10), period: "provider-cost-year" },
  ];
  for (const entry of strange) {
    const problems = providerHoldProblems({ holds: [entry], entries: [] });
    assert.ok(problems.length > 0, JSON.stringify(entry));
  }
});

test("a negative hold is refused", () => {
  const holds = [hold(0, "openai", "day", -5)];
  assert.match(
    providerHoldProblems({ holds, entries: entriesFor(holds) }).join(" "),
    /negative amount/
  );
});

test("non-provider entries are none of this module's business", () => {
  // A user's own quota rows sit in the same list and are settled by a
  // different rule; the validator must not claim they are unheld.
  const holds = pair(0, "openai", 100);
  const entries = [
    ...entriesFor(holds),
    { key: "user:abc", period: "day", periodStart: day, amount: 3 },
  ];
  assert.deepEqual(providerHoldProblems({ holds, entries }), []);
});

// A hold is one provider, one day, one month, both the same amount. The
// looser rule these replace let every shape below through, and each leaves a
// bucket that release cannot fully give back — release subtracts what the
// holds say was put there.

test("an attempt holding two providers is refused", () => {
  const holds = [hold(0, "openai", "day", 10), hold(0, "google", "month", 10)];
  assert.match(
    providerHoldProblems({ holds, entries: entriesFor(holds) }).join(" "),
    /holds 2 providers; an attempt runs on one/
  );
});

test("a hold missing its month is refused", () => {
  const holds = [hold(0, "openai", "day", 10)];
  assert.match(
    providerHoldProblems({ holds, entries: entriesFor(holds) }).join(" "),
    /holds 0 provider-cost-month rows/
  );
});

test("a hold missing its day is refused", () => {
  const holds = [hold(0, "openai", "month", 10)];
  assert.match(
    providerHoldProblems({ holds, entries: entriesFor(holds) }).join(" "),
    /holds 0 provider-cost-day rows/
  );
});

test("day and month holding different amounts is refused", () => {
  // They are one reservation seen through two windows, so they cannot differ.
  const holds = [hold(0, "openai", "day", 10), hold(0, "openai", "month", 40)];
  assert.match(
    providerHoldProblems({ holds, entries: entriesFor(holds) }).join(" "),
    /the day and month holds are the same reservation/
  );
});

test("two well-formed attempts on one provider are still accepted", () => {
  // The rules are per attempt, not per provider: sharing a bucket is the
  // normal same-provider fallback and must not be caught by them.
  const holds = [...pair(0, "openai", 100), ...pair(1, "openai", 40)];
  assert.deepEqual(providerHoldProblems({ holds, entries: entriesFor(holds) }), []);
});

// The cost intent beside each hold. Its whole job is to survive the process
// that took it, so what matters is that it cannot drift from the holds it was
// written with -- an intent with no hold would let a crash record a cost
// against budget nobody reserved.

const intent = (attemptIndex, provider = "openai", reserved = 100) => ({
  attemptIndex,
  modelId: `${provider}-model`,
  provider,
  estimatedInputTokens: 1_000,
  reservedOutputTokens: 1_000,
  inputUsdPerMillionTokens: 100,
  outputUsdPerMillionTokens: 100,
  cachedInputPriceMultiplier: 1,
  pricingVersion: "test",
  reservedCostMicroUsd: reserved,
});

test("an intent for every hold, and a hold for every intent, is accepted", () => {
  const holds = [...pair(0, "openai", 100), ...pair(1, "google", 40)];
  assert.deepEqual(
    attemptCostIntentProblems({
      holds,
      intents: [intent(0, "openai", 100), intent(1, "google", 40)],
    }),
    []
  );
});

test("an intent with no hold is refused", () => {
  // It would let a crash record a cost against budget nobody reserved.
  assert.match(
    attemptCostIntentProblems({
      holds: pair(0, "openai", 100),
      intents: [intent(0), intent(1, "google", 40)],
    }).join(" "),
    /attempt 1 has a cost intent and no hold/
  );
});

test("a hold with no intent is refused", () => {
  // The gap the whole mechanism exists to close: money committed and nothing
  // able to say what it was for.
  assert.match(
    attemptCostIntentProblems({
      holds: [...pair(0, "openai", 100), ...pair(1, "google", 40)],
      intents: [intent(0)],
    }).join(" "),
    /attempt 1 has a hold and no cost intent/
  );
});

test("two intents for one attempt are refused", () => {
  assert.match(
    attemptCostIntentProblems({
      holds: pair(0, "openai", 100),
      intents: [intent(0), intent(0, "google", 40)],
    }).join(" "),
    /two cost intents share an attemptIndex/
  );
});

test("no holds and no intents is not a problem", () => {
  // A turn that reserved no provider budget -- a zero-rate model -- takes
  // neither, and neither is missing.
  assert.deepEqual(attemptCostIntentProblems({ holds: [], intents: [] }), []);
});

test("an attempt's intent is found by its index, and a missing one is null", () => {
  const intents = [intent(0), intent(1, "google", 40)];
  assert.equal(costIntentFor(intents, 1).provider, "google");
  assert.equal(costIntentFor(intents, 2), null);
  // A payload written before intents existed carries none at all, and the
  // sweep has to read that as "cannot be priced" rather than crash.
  assert.equal(costIntentFor(undefined, 0), null);
});
