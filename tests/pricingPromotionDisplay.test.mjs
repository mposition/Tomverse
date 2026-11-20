import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { displayablePromotion } from "../components/marketing/v2/pricing/pricingPromotion.ts";

const promotion = (discountPercent, discountAmountCents = null) => ({
  code: "TOMVERSE50",
  discountPercent,
  discountAmountCents,
  durationMonths: 1,
  appliesToPlanIds: ["pro", "max"],
  billingIntervals: ["monthly"],
  endsAt: "2026-12-31T00:00:00.000Z",
});

test("only a percentage promotion is shown on the pricing page", () => {
  const percent = promotion(50);
  assert.equal(displayablePromotion(percent), percent);
  // A fixed-amount promotion would read as 0% off at full price while checkout charged less.
  assert.equal(displayablePromotion(promotion(0, 500)), null);
  assert.equal(displayablePromotion(promotion(100)), null);
  assert.equal(displayablePromotion(promotion(Number.NaN)), null);
  assert.equal(displayablePromotion(null), null);
  assert.equal(displayablePromotion(undefined), null);
});

test("the pricing page states paid prices and savings only from the live billing config", () => {
  const page = readFileSync(new URL("../components/marketing/v2/pricing/PricingPage.tsx", import.meta.url), "utf8");
  // No built-in default plan table on the page: a price it shows is one checkout charges.
  assert.doesNotMatch(page, /getDefaultBillingPlan/);
  assert.match(page, /displayablePromotion\(billing\.config\?\.featuredPromotion\)/);
  assert.match(page, /const livePrice = planId === "free" \|\| Boolean\(publicPlan\);/);
  assert.match(page, /const PRICE_PENDING = "—";/);
});
