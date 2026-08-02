import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  buildCorrectionCandidates,
  expectedCostMicroUsd,
  type CurrentPrice,
  type SettledReservationSample,
} from "@/lib/costBucketCorrectionCore";

const THIS_MONTH = "2026-08-01T00:00:00.000Z";
const LAST_MONTH = "2026-07-01T00:00:00.000Z";

const price: CurrentPrice = {
  inputUsdPerMillionTokens: 0.75,
  outputUsdPerMillionTokens: 4.5,
  cachedInputPriceMultiplier: 0.1,
  pricingVersion: "openai-gpt-5.4-mini-2026-08-01",
};

const sample = (
  overrides: Partial<SettledReservationSample> = {}
): SettledReservationSample => ({
  modelId: "gpt-5-4-mini",
  period: "op-cost-month",
  periodStart: THIS_MONTH,
  pricingVersion: "fallback-2026-08-01",
  costSource: "conservative_fallback",
  bookedCostMicroUsd: 1_000,
  settledInputTokens: 1_000,
  settledCachedInputTokens: 0,
  settledOutputTokens: 1_000,
  ...overrides,
});

const candidates = (
  samples: SettledReservationSample[],
  overrides: Partial<Parameters<typeof buildCorrectionCandidates>[0]> = {}
) =>
  buildCorrectionCandidates({
    samples,
    priceForModel: () => price,
    currentPeriodStarts: { "op-cost-month": THIS_MONTH },
    ...overrides,
  });

test("cached input is charged at the multiplier and the rest at full rate", () => {
  const cost = expectedCostMicroUsd(
    sample({
      settledInputTokens: 1_000,
      settledCachedInputTokens: 400,
      settledOutputTokens: 2_000,
    }),
    price
  );
  // 600 uncached x 0.75 + 400 cached x 0.75 x 0.1 + 2,000 output x 4.5
  assert.equal(cost, 600 * 0.75 + 400 * 0.075 + 2_000 * 4.5);
});

test("more cached tokens than input tokens cannot produce a negative charge", () => {
  const cost = expectedCostMicroUsd(
    sample({
      settledInputTokens: 100,
      settledCachedInputTokens: 5_000,
      settledOutputTokens: 0,
    }),
    price
  );
  assert.equal(cost, 100 * 0.075);
});

test("a booked figure that matches today's price produces no candidate", () => {
  const matching = sample({
    settledInputTokens: 1_000,
    settledOutputTokens: 1_000,
    bookedCostMicroUsd: 1_000 * 0.75 + 1_000 * 4.5,
  });
  assert.deepEqual(candidates([matching], { minimumDifferenceMicroUsd: 100 }), []);
});

test("an overstatement is reported with its size and its ratio", () => {
  // The real shape of the incident: booked at the US$15/US$60 fallback,
  // expected at the published US$0.75/US$4.50.
  const overstated = sample({
    settledInputTokens: 1_000_000,
    settledOutputTokens: 1_000_000,
    bookedCostMicroUsd: 1_000_000 * 15 + 1_000_000 * 60,
  });
  const [candidate] = candidates([overstated]);
  assert.equal(candidate.expectedCostMicroUsd, 1_000_000 * 0.75 + 1_000_000 * 4.5);
  assert.equal(
    candidate.differenceMicroUsd,
    75_000_000 - 5_250_000
  );
  assert.ok((candidate.overstatementRatio ?? 0) > 13);
});

test("groups keep period, model, pricingVersion and costSource apart", () => {
  // Collapsing these would let someone adjust "the model's cost" without
  // seeing that several differently-priced decisions sit underneath it.
  const grouped = candidates([
    sample({ pricingVersion: "fallback-2026-08-01" }),
    sample({ pricingVersion: "fallback-2026-08-01" }),
    sample({ pricingVersion: "openai-gpt-5.4-mini-2026-08-01" }),
    sample({ costSource: "registry" }),
    sample({ modelId: "gpt-5-6-luna" }),
    sample({ periodStart: LAST_MONTH }),
    sample({ period: "op-cost-day" }),
  ]);
  assert.equal(grouped.length, 6);
  const doubled = grouped.find(
    (candidate) => candidate.reservationCount === 2
  );
  assert.ok(doubled, "the two identical samples must merge into one group");
  assert.equal(doubled.bookedCostMicroUsd, 2_000);
});

test("the period still accruing is flagged and sorted first", () => {
  // A closed month's overstatement is bookkeeping. The open one is what is
  // rejecting requests right now.
  const results = candidates([
    sample({ periodStart: LAST_MONTH, bookedCostMicroUsd: 9_000_000 }),
    sample({ periodStart: THIS_MONTH, bookedCostMicroUsd: 1_000_000 }),
  ]);
  assert.equal(results[0].isCurrentBlock, true);
  assert.equal(results[0].periodStart, THIS_MONTH);
  assert.equal(results[1].isCurrentBlock, false);
});

test("a model with no current price is skipped, never repriced against a guess", () => {
  const results = buildCorrectionCandidates({
    samples: [sample({ modelId: "a-model-that-no-longer-exists" })],
    priceForModel: () => null,
    currentPeriodStarts: {},
  });
  assert.deepEqual(results, []);
});

test("differences below the noise floor are suppressed", () => {
  const results = candidates(
    [sample({ bookedCostMicroUsd: 1_000 * 0.75 + 1_000 * 4.5 + 50 })],
    { minimumDifferenceMicroUsd: 100 }
  );
  assert.deepEqual(results, []);
});

test("the reporting script never writes", () => {
  const source = readFileSync(
    join(process.cwd(), "scripts/report-cost-bucket-corrections.mjs"),
    "utf8"
  );
  for (const write of [
    ".update(",
    ".updateMany(",
    ".upsert(",
    ".create(",
    ".createMany(",
    ".delete(",
    ".deleteMany(",
    "$executeRaw",
  ]) {
    assert.equal(source.includes(write), false, write);
  }
  assert.equal(source.includes("chatUsageBucket"), false);
});
