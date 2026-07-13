import assert from "node:assert/strict";
import test from "node:test";
import {
  promotionEligibilityFailure,
  promotionValidationError,
} from "../lib/billingPromotionCore.ts";

const promotion = (overrides = {}) => ({
  isActive: true,
  maxRedemptions: 100,
  redeemedCount: 2,
  startsAt: "2026-07-12T00:00:00.000Z",
  endsAt: "2026-07-19T00:00:00.000Z",
  appliesToPlanIds: ["pro", "max"],
  allowAnnualStacking: false,
  discountPercent: 50,
  discountAmountCents: null,
  ...overrides,
});

const now = new Date("2026-07-13T12:00:00.000Z");

test("eligible monthly promotions pass validation", () => {
  assert.equal(
    promotionEligibilityFailure({
      promotion: promotion(),
      planId: "pro",
      billingInterval: "monthly",
      now,
    }),
    null
  );
});

test("promotion validation reports actionable eligibility failures", () => {
  assert.equal(
    promotionEligibilityFailure({
      promotion: promotion(),
      planId: "pro",
      billingInterval: "annual",
      now,
    }),
    "annual_not_allowed"
  );
  assert.equal(
    promotionEligibilityFailure({
      promotion: promotion({ redeemedCount: 100 }),
      planId: "pro",
      billingInterval: "monthly",
      now,
    }),
    "redemption_limit"
  );
  assert.equal(
    promotionEligibilityFailure({
      promotion: promotion({ isActive: false }),
      planId: "pro",
      billingInterval: "monthly",
      now,
    }),
    "unavailable"
  );
});

test("promotion validation errors have stable public codes", () => {
  assert.deepEqual(promotionValidationError("annual_not_allowed"), {
    status: 400,
    code: "PROMOTION_ANNUAL_NOT_ALLOWED",
    message: "This promotion can only be used with monthly billing.",
  });
  assert.equal(
    promotionValidationError("already_used").code,
    "PROMOTION_ALREADY_USED"
  );
  assert.equal(
    promotionValidationError("invalid").message,
    "Invalid promotion code."
  );
});
