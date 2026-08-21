import assert from "node:assert/strict";
import test from "node:test";
import {
  fixedAmountPromotionRefusal,
  fixedAmountPromotionRefusals,
} from "../lib/billingPromotionAdminPolicy.ts";
import { isFixedAmountPromotion } from "../lib/billingPromotionCore.ts";

/**
 * Every row of docs/policy/promotion-discount-currency.md section 4, as a test.
 *
 * The matrix is short but its two halves pull in opposite directions -- keep
 * existing fixed-amount codes usable, refuse anything that makes one reach
 * further -- so each row is asserted on its own, and the allowed rows are
 * asserted just as explicitly as the refused ones. A change that starts
 * refusing "pause this code" would be as much a policy break as one that
 * starts allowing "raise this discount"; the operator loses the ability to
 * switch off a live promotion.
 */

const fixedAmount = (overrides = {}) => ({
  code: "PAYMENTTEST27",
  discountPercent: 0,
  discountAmountCents: 1400,
  maxRedemptions: 100,
  durationMonths: 1,
  appliesToPlanIds: ["pro"],
  startsAt: "2026-07-01T00:00:00.000Z",
  endsAt: "2026-09-01T00:00:00.000Z",
  isActive: true,
  ...overrides,
});

const percentage = (overrides = {}) =>
  fixedAmount({ discountPercent: 50, discountAmountCents: null, ...overrides });

const reasonFor = (existing, next) =>
  fixedAmountPromotionRefusal({ existing, next })?.reason || null;

test("a promotion carrying both a percent and an amount is a percentage promotion", () => {
  // What the customer is charged decides this, not which fields are filled in:
  // promotionDiscountedMinor() applies the percent and ignores the amount.
  assert.equal(
    isFixedAmountPromotion({ discountPercent: 50, discountAmountCents: 1400 }),
    false
  );
  assert.equal(
    isFixedAmountPromotion({ discountPercent: 0, discountAmountCents: 1400 }),
    true
  );
  assert.equal(
    isFixedAmountPromotion({ discountPercent: 0, discountAmountCents: null }),
    false
  );
});

test("creating a fixed-amount promotion is refused", () => {
  assert.equal(reasonFor(null, fixedAmount()), "creation");
});

test("creating a percentage promotion is untouched", () => {
  assert.equal(reasonFor(null, percentage()), null);
});

test("turning an existing percentage promotion into a fixed-amount one is refused", () => {
  // Otherwise the creation block is a formality: create a percentage code,
  // save, then edit in the amount.
  assert.equal(
    reasonFor(percentage(), fixedAmount({ code: percentage().code })),
    "converted_to_fixed_amount"
  );
});

test("rewriting a fixed-amount promotion as a percentage one is refused", () => {
  // Section 4's last row: create a new code instead. The same code string
  // meaning two different discounts cannot be reconciled against the
  // redemptions already recorded under it.
  assert.equal(
    reasonFor(fixedAmount(), percentage({ code: fixedAmount().code })),
    "converted_to_percentage"
  );
});

test("reactivating an inactive fixed-amount promotion is refused", () => {
  assert.equal(
    reasonFor(fixedAmount({ isActive: false }), fixedAmount({ isActive: true })),
    "reactivation"
  );
});

test("renaming a fixed-amount promotion is refused", () => {
  assert.equal(
    reasonFor(fixedAmount(), fixedAmount({ code: "NEWCAMPAIGN" })),
    "code_changed"
  );
});

test("raising a fixed-amount discount is refused and lowering it is allowed", () => {
  assert.equal(
    reasonFor(fixedAmount(), fixedAmount({ discountAmountCents: 1500 })),
    "amount_increase"
  );
  assert.equal(
    reasonFor(fixedAmount(), fixedAmount({ discountAmountCents: 500 })),
    null
  );
});

test("adding a plan is refused and removing one is allowed", () => {
  assert.equal(
    reasonFor(fixedAmount(), fixedAmount({ appliesToPlanIds: ["pro", "max"] })),
    "plan_added"
  );
  assert.equal(
    reasonFor(
      fixedAmount({ appliesToPlanIds: ["pro", "max"] }),
      fixedAmount({ appliesToPlanIds: ["pro"] })
    ),
    null
  );
});

test("pushing the end date back or removing it is refused, bringing it forward is allowed", () => {
  assert.equal(
    reasonFor(fixedAmount(), fixedAmount({ endsAt: "2026-10-01T00:00:00.000Z" })),
    "end_date_extended"
  );
  // A promotion that stops expiring is the widest edit available, and it is
  // spelled as an omitted field rather than a larger number.
  assert.equal(
    reasonFor(fixedAmount(), fixedAmount({ endsAt: null })),
    "end_date_extended"
  );
  assert.equal(
    reasonFor(fixedAmount(), fixedAmount({ endsAt: "2026-08-01T00:00:00.000Z" })),
    null
  );
});

test("moving the start date earlier or dropping it is refused, delaying it is allowed", () => {
  assert.equal(
    reasonFor(fixedAmount(), fixedAmount({ startsAt: "2026-06-01T00:00:00.000Z" })),
    "start_date_advanced"
  );
  assert.equal(
    reasonFor(fixedAmount(), fixedAmount({ startsAt: null })),
    "start_date_advanced"
  );
  assert.equal(
    reasonFor(fixedAmount(), fixedAmount({ startsAt: "2026-07-15T00:00:00.000Z" })),
    null
  );
  // A promotion that never had a start date cannot be widened by gaining one.
  assert.equal(
    reasonFor(
      fixedAmount({ startsAt: null }),
      fixedAmount({ startsAt: "2026-07-15T00:00:00.000Z" })
    ),
    null
  );
});

test("raising or removing the redemption cap is refused, lowering it is allowed", () => {
  assert.equal(
    reasonFor(fixedAmount(), fixedAmount({ maxRedemptions: 200 })),
    "redemption_cap_raised"
  );
  assert.equal(
    reasonFor(fixedAmount(), fixedAmount({ maxRedemptions: null })),
    "redemption_cap_raised"
  );
  assert.equal(
    reasonFor(fixedAmount(), fixedAmount({ maxRedemptions: 10 })),
    null
  );
});

test("extending the duration in months is refused, shortening it is allowed", () => {
  assert.equal(
    reasonFor(fixedAmount(), fixedAmount({ durationMonths: 3 })),
    "duration_extended"
  );
  assert.equal(
    reasonFor(fixedAmount({ durationMonths: 3 }), fixedAmount({ durationMonths: 1 })),
    null
  );
});

test("deactivating a fixed-amount promotion is allowed", () => {
  // The one edit an operator must always be able to make. Refusing it would
  // leave a live promotion that nothing can switch off.
  assert.equal(
    reasonFor(fixedAmount(), fixedAmount({ isActive: false })),
    null
  );
  // Including together with a narrowing edit in the same save.
  assert.equal(
    reasonFor(
      fixedAmount(),
      fixedAmount({ isActive: false, endsAt: "2026-07-20T00:00:00.000Z" })
    ),
    null
  );
});

test("resaving a fixed-amount promotion unchanged is allowed", () => {
  // The Admin panel PATCHes the whole promotion list on every save, so an
  // untouched fixed-amount row rides along with every unrelated edit. Refusing
  // it would freeze the entire billing form.
  assert.equal(reasonFor(fixedAmount(), fixedAmount()), null);
});

test("percentage promotions are not constrained by any of this", () => {
  assert.equal(
    reasonFor(
      percentage({ isActive: false }),
      percentage({
        isActive: true,
        discountPercent: 90,
        appliesToPlanIds: ["pro", "max"],
        endsAt: "2027-01-01T00:00:00.000Z",
        maxRedemptions: 100_000,
        durationMonths: 12,
      })
    ),
    null
  );
});

test("every refusal in one save is reported, in the order they were sent", () => {
  const refusals = fixedAmountPromotionRefusals([
    { existing: null, next: fixedAmount({ code: "NEWFIXED" }) },
    { existing: fixedAmount(), next: fixedAmount() },
    { existing: null, next: percentage({ code: "NEWPERCENT" }) },
    {
      existing: fixedAmount({ code: "OLDFIXED", isActive: false }),
      next: fixedAmount({ code: "OLDFIXED", isActive: true }),
    },
  ]);
  assert.deepEqual(
    refusals.map((item) => [item.code, item.reason]),
    [
      ["NEWFIXED", "creation"],
      ["OLDFIXED", "reactivation"],
    ]
  );
});

test("a refusal names the policy that produced it", () => {
  const refusal = fixedAmountPromotionRefusal({
    existing: null,
    next: fixedAmount(),
  });
  assert.ok(
    refusal.message.includes("docs/policy/promotion-discount-currency.md"),
    "an operator refused a save has to be able to find out why"
  );
});
