import assert from "node:assert/strict";
import test from "node:test";
import {
  FIXED_AMOUNT_PROMOTION_CURRENCIES,
  promotionCurrencyFailure,
  promotionDiscountedMinor,
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

test("internal passes require an exact bounded duration and a 100% discount", () => {
  assert.equal(
    promotionEligibilityFailure({
      promotion: promotion({
        fulfillmentType: "internal_pass",
        accessDurationDays: 60,
        discountPercent: 100,
        appliesToPlanIds: ["pro"],
      }),
      planId: "pro",
      billingInterval: "monthly",
      now,
    }),
    null
  );
  assert.equal(
    promotionEligibilityFailure({
      promotion: promotion({
        fulfillmentType: "internal_pass",
        accessDurationDays: null,
        discountPercent: 100,
        appliesToPlanIds: ["pro"],
      }),
      planId: "pro",
      billingInterval: "monthly",
      now,
    }),
    "unavailable"
  );
  assert.equal(
    promotionEligibilityFailure({
      promotion: promotion({
        fulfillmentType: "internal_pass",
        accessDurationDays: 60,
        discountPercent: 50,
        appliesToPlanIds: ["pro"],
      }),
      planId: "pro",
      billingInterval: "monthly",
      now,
    }),
    "unavailable"
  );
});

/* -------------------------------------------------------------------------- */
/* Which currency a promotion can be charged in                                */
/* -------------------------------------------------------------------------- */

/**
 * `discountAmountCents` is a USD amount and the schema says nothing else, so
 * USD is the only currency in which the stored number means what it says.
 *
 * The reported failure: PAYMENTTEST27, a $14 fixed discount, applied against a
 * Pro plan priced at A$20.00. Validation returned valid, the order summary said
 * "-$14" and "A$1.33 due today", and Checkout refused the purchase. The summary
 * had reached A$1.33 by turning $14 off a $15 USD plan into a 93.3% ratio and
 * applying that ratio to the Australian price -- a discount no one approved, in
 * a currency nobody stored it in.
 */

const NON_USD = ["AUD", "CNY", "EUR", "KRW"];

const percentPromotion = { discountPercent: 100, discountAmountCents: null };
const fixedPromotion = { discountPercent: 0, discountAmountCents: 1400 };

test("a percentage promotion is chargeable in every supported currency", () => {
  for (const currency of ["USD", ...NON_USD]) {
    assert.equal(
      promotionCurrencyFailure({ promotion: percentPromotion, currency }),
      null,
      `percent should be allowed in ${currency}`
    );
  }
});

test("a fixed-amount promotion is chargeable in USD", () => {
  assert.equal(
    promotionCurrencyFailure({ promotion: fixedPromotion, currency: "USD" }),
    null
  );
  assert.deepEqual(FIXED_AMOUNT_PROMOTION_CURRENCIES, ["USD"]);
});

test("a fixed-amount promotion is refused in every other currency", () => {
  for (const currency of NON_USD) {
    assert.equal(
      promotionCurrencyFailure({ promotion: fixedPromotion, currency }),
      "currency_not_supported",
      `fixed should be refused in ${currency}`
    );
  }
});

test("an internal pass is not held to a rule about Stripe coupons", () => {
  // It never becomes one: the pass is fulfilled by granting an access period.
  assert.equal(
    promotionCurrencyFailure({
      promotion: {
        discountPercent: 100,
        discountAmountCents: null,
        fulfillmentType: "internal_pass",
      },
      currency: "AUD",
    }),
    null
  );
});

test("a promotion that discounts nothing is not relabelled as a currency problem", () => {
  // `promotionEligibilityFailure` already calls this one unavailable. Answering
  // "currency" here would send the customer looking for a percentage code that
  // would not work either.
  assert.equal(
    promotionCurrencyFailure({
      promotion: { discountPercent: 0, discountAmountCents: null },
      currency: "AUD",
    }),
    null
  );
});

test("the refusal has its own code and names the action", () => {
  const error = promotionValidationError("currency_not_supported");
  assert.equal(error.status, 400);
  assert.equal(error.code, "PROMOTION_CURRENCY_NOT_SUPPORTED");
  assert.match(error.message, /percentage/i);
  // Not folded into the generic refusal: the client localises by code, and
  // "not currently available" would be wrong about a code that is available
  // somewhere else.
  assert.notEqual(error.code, promotionValidationError("unavailable").code);
});

test("a fixed discount is subtracted, never converted to a ratio", () => {
  // The exact numbers from the report. 2000 minor at the ratio the UI used to
  // compute is 133; the only correct answers are "subtract 1400 from the USD
  // amount" and "do not apply this at all".
  assert.equal(promotionDiscountedMinor(1500, fixedPromotion), 100);
  assert.equal(promotionDiscountedMinor(2000, fixedPromotion), 600);
  assert.notEqual(promotionDiscountedMinor(2000, fixedPromotion), 133);
});
