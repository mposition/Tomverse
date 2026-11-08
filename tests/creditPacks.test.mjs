import assert from "node:assert/strict";
import test from "node:test";
import { infoPages } from "../components/marketing/marketingInfoContent.ts";
import {
  getCreditPacksForPlan,
  getPublicCreditPackCatalog,
  recommendCreditAction,
} from "../lib/creditPacks.ts";

test("public terms and refunds use the catalog's fixed day count for additional credits", () => {
  const days = [...new Set(getPublicCreditPackCatalog().map((pack) => pack.validityDays))];
  assert.deepEqual(days, [365]);
  for (const page of [infoPages.terms, infoPages.refund]) {
    for (const [locale, duration] of [["en", `${days[0]} days`], ["ko", `${days[0]}일`], ["zh", `${days[0]} 天`]]) {
      const copy = page[locale].sections.map((section) => section.body).join(" ");
      assert.ok(copy.includes(duration), `${locale}: missing catalog validity`);
      assert.doesNotMatch(copy, /12 months \(365 days\)|12개월\(365일\)|12 个月（365 天）/);
    }
  }
});

test("public credit-pack catalog exposes prices and eligibility without payment secrets", () => {
  const catalog = getPublicCreditPackCatalog();

  assert.deepEqual(
    catalog.map((pack) => [pack.id, pack.credits, pack.priceCents, pack.allowedPlans]),
    [
      ["starter_500", 500, 499, ["Free"]],
      ["project_1500", 1_500, 999, ["Pro", "Max"]],
      ["power_4000", 4_000, 1_999, ["Pro", "Max"]],
    ]
  );
  for (const pack of catalog) {
    assert.equal("stripePriceId" in pack, false);
    assert.equal("fundedCostMicroUsd" in pack, false);
  }
});

test("Free can only buy the small starter pack", () => {
  assert.deepEqual(
    getCreditPacksForPlan("Free").map((pack) => [pack.id, pack.credits, pack.priceCents]),
    [["starter_500", 500, 499]]
  );
});

test("Pro and Max receive the project and power packs", () => {
  for (const plan of ["Pro", "Max"]) {
    assert.deepEqual(
      getCreditPacksForPlan(plan).map((pack) => pack.id),
      ["project_1500", "power_4000"]
    );
  }
});

test("recommendations prefer upgrades for sustained high usage", () => {
  assert.deepEqual(
    recommendCreditAction({
      plan: "Free",
      monthlyUsagePercents: [100],
      addOnPurchasesLast90Days: 0,
    }),
    { primary: "upgrade_pro", secondary: "add_credits" }
  );
  assert.deepEqual(
    recommendCreditAction({
      plan: "Pro",
      monthlyUsagePercents: [82, 91],
      addOnPurchasesLast90Days: 0,
    }),
    { primary: "upgrade_max", secondary: "add_credits" }
  );
  assert.deepEqual(
    recommendCreditAction({
      plan: "Max",
      monthlyUsagePercents: [100, 100],
      addOnPurchasesLast90Days: 2,
    }),
    { primary: "add_credits", secondary: "business" }
  );
});
