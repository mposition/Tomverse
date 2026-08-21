import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_BILLING_PRICE_CATALOG,
  billingPriceCatalogSchema,
} from "../lib/billingPriceCatalog.ts";

/**
 * `DEFAULT_BILLING_PRICE_CATALOG` is a price list, not a fixture.
 *
 * Three production paths charge it: no `AppSetting` row, a row that does not
 * parse, and a row that fails the schema. So editing a number in that module is
 * editing what a customer can be charged, and this file exists to make that
 * impossible to do quietly -- a change here has to be a deliberate line in the
 * diff, next to the invariants below that say what a plausible price looks
 * like.
 *
 * The pinned values are what production has stored since 2026-08-14, verified
 * against the database with `npm run report:billing-price-catalog` and aligned
 * under #637.
 */

const APPROVED = {
  plans: {
    pro: {
      AUD: { monthly: 2_000, annual: 19_200 },
      CNY: { monthly: 9_900, annual: 95_000 },
      EUR: { monthly: 1_400, annual: 13_400 },
      KRW: { monthly: 20_000, annual: 192_000 },
    },
    max: {
      AUD: { monthly: 3_900, annual: 37_400 },
      CNY: { monthly: 18_000, annual: 172_800 },
      EUR: { monthly: 2_300, annual: 22_000 },
      KRW: { monthly: 35_000, annual: 336_000 },
    },
  },
  creditPacks: {
    starter_500: { USD: 499, AUD: 700, CNY: 3_300, EUR: 450, KRW: 7_000 },
    project_1500: { USD: 999, AUD: 1_400, CNY: 6_500, EUR: 900, KRW: 14_000 },
    power_4000: { USD: 1_999, AUD: 2_800, CNY: 13_500, EUR: 1_800, KRW: 28_000 },
  },
};

test("the default catalogue holds the approved prices", () => {
  // Deliberately a whole-object comparison rather than a spot check: a price
  // this test does not mention is a price that could move without review.
  assert.deepEqual(DEFAULT_BILLING_PRICE_CATALOG.plans, APPROVED.plans);
  assert.deepEqual(
    DEFAULT_BILLING_PRICE_CATALOG.creditPacks,
    APPROVED.creditPacks
  );
});

test("the default catalogue is a value the schema would accept", () => {
  // It is written into the database verbatim when the row is missing, and read
  // back through `billingPriceCatalogSchema.parse()` in the same call. A
  // default that failed its own schema would throw on a fresh deployment.
  assert.doesNotThrow(() =>
    billingPriceCatalogSchema.parse(DEFAULT_BILLING_PRICE_CATALOG)
  );
});

test("every annual price is a discount on twelve monthly payments, near 20%", () => {
  // The invariant, not the numbers: annual is sold as roughly a fifth off. A
  // typo that dropped or added a digit -- 37_400 written as 3_740, or 336_000
  // as 3_360_000 -- lands far outside this band, which a value-by-value pin
  // alone would not describe.
  for (const [planId, currencies] of Object.entries(
    DEFAULT_BILLING_PRICE_CATALOG.plans
  )) {
    for (const [currency, prices] of Object.entries(currencies)) {
      const ratio = prices.annual / (prices.monthly * 12);
      assert.ok(
        ratio > 0.78 && ratio < 0.82,
        `${planId}.${currency}: annual is ${(ratio * 100).toFixed(1)}% of twelve monthly payments, which is outside the 18-22% discount band`
      );
    }
  }
});

test("Max costs more than Pro in every currency and interval", () => {
  for (const currency of ["AUD", "CNY", "EUR", "KRW"]) {
    for (const interval of ["monthly", "annual"]) {
      assert.ok(
        DEFAULT_BILLING_PRICE_CATALOG.plans.max[currency][interval] >
          DEFAULT_BILLING_PRICE_CATALOG.plans.pro[currency][interval],
        `${currency} ${interval}: Max must not be cheaper than Pro`
      );
    }
  }
});

test("a bigger credit pack never costs less than a smaller one", () => {
  const order = ["starter_500", "project_1500", "power_4000"];
  for (const currency of ["USD", "AUD", "CNY", "EUR", "KRW"]) {
    for (let index = 1; index < order.length; index += 1) {
      assert.ok(
        DEFAULT_BILLING_PRICE_CATALOG.creditPacks[order[index]][currency] >
          DEFAULT_BILLING_PRICE_CATALOG.creditPacks[order[index - 1]][currency],
        `${currency}: ${order[index]} must cost more than ${order[index - 1]}`
      );
    }
  }
});

test("USD credit-pack prices are the only USD numbers here, and they are unchanged", () => {
  // Plan prices in USD come from `BillingPlan`, not this table. The USD pack
  // prices were untouched by the 2026-08-14 repricing, which only moved the
  // localized markets, and pinning them separately keeps that boundary visible.
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(DEFAULT_BILLING_PRICE_CATALOG.creditPacks).map(
        ([packId, prices]) => [packId, prices.USD]
      )
    ),
    { starter_500: 499, project_1500: 999, power_4000: 1_999 }
  );
});
