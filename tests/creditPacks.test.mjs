import assert from "node:assert/strict";
import test from "node:test";
import {
  getCreditPacksForPlan,
  recommendCreditAction,
} from "../lib/creditPacks.ts";

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
