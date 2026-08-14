import assert from "node:assert/strict";
import test from "node:test";
import {
  canAdoptStripePromotionCode,
  canUseStripePromotionCode,
  checkoutSessionIdempotencyKey,
  couponMismatches,
  describeMismatches,
  errorCodeForMismatches,
  expectedCouponForPromotion,
  externalCheckoutError,
  isMissingResourceStripeError,
  isRetryableStripeError,
  promotionCodeIdempotencyKey,
  promotionCodeMismatches,
  promotionCouponIdempotencyKey,
  planMetadataMismatch,
  promotionPolicyVersion,
  promotionStripePolicyViolation,
  stripeCustomerIdempotencyKey,
  stripeErrorFacts,
  stripeKeyLiveMode,
} from "../lib/stripePromotionProvisioningCore.ts";

/**
 * The matching rules that decide whether a Stripe object may back a Tomverse
 * promotion. They are only reachable in production otherwise, so this is where
 * the interesting cases live: a code that is not ours, a coupon whose discount
 * has drifted, a test-mode object stored against a live deployment.
 */

const ENDS_AT = "2026-08-15T00:00:00.000Z";
const ENDS_AT_SECONDS = Math.floor(new Date(ENDS_AT).getTime() / 1000);
const NOW_SECONDS = Math.floor(
  new Date("2026-08-02T00:00:00.000Z").getTime() / 1000
);

// Modelled on the promotion that exposed the outage: 100% off Max for one
// month, capped, with an expiry.
const promotion = (overrides = {}) => ({
  id: "promo_1783819720812",
  code: "EDDIEFRIEND100",
  discountPercent: 100,
  discountAmountCents: null,
  durationMonths: 1,
  maxRedemptions: 1000,
  endsAt: ENDS_AT,
  ...overrides,
});

const coupon = (overrides = {}) => ({
  id: "cpn_live",
  livemode: true,
  valid: true,
  percentOff: 100,
  amountOff: null,
  currency: null,
  duration: "repeating",
  durationInMonths: 1,
  metadata: { tomversePromotionId: "promo_1783819720812", planId: "max" },
  appliesToProducts: null,
  ...overrides,
});

const promotionCode = (overrides = {}) => ({
  id: "promo_stripe_live",
  code: "EDDIEFRIEND100",
  active: true,
  livemode: true,
  couponId: "cpn_live",
  customerId: null,
  maxRedemptions: 1000,
  timesRedeemed: 0,
  expiresAtSeconds: ENDS_AT_SECONDS,
  metadata: { tomversePromotionId: "promo_1783819720812", planId: "max" },
  ...overrides,
});

const codeMismatches = (overrides = {}, extra = {}) =>
  promotionCodeMismatches({
    promotionCode: promotionCode(overrides),
    promotion: promotion(),
    planId: "max",
    expectLiveMode: true,
    expectedCouponId: "cpn_live",
    nowSeconds: NOW_SECONDS,
    customerId: "cus_current",
    ...extra,
  });

const couponMismatchesFor = (overrides = {}, extra = {}) =>
  couponMismatches({
    coupon: coupon(overrides),
    promotion: promotion(),
    planId: "max",
    expectLiveMode: true,
    ...extra,
  });

test("a healthy live promotion code and coupon match with no complaints", () => {
  assert.deepEqual(codeMismatches(), []);
  assert.deepEqual(couponMismatchesFor(), []);
  assert.equal(canUseStripePromotionCode([]), true);
  assert.equal(canAdoptStripePromotionCode([]), true);
});

test("a percentage promotion expects percent_off and no currency", () => {
  assert.deepEqual(expectedCouponForPromotion(promotion(), "max"), {
    percentOff: 100,
    amountOff: null,
    currency: null,
    duration: "repeating",
    durationInMonths: 1,
    metadata: { tomversePromotionId: "promo_1783819720812", planId: "max" },
  });
});

test("a fixed-amount promotion expects amount_off in USD", () => {
  const fixed = promotion({ discountPercent: 0, discountAmountCents: 500 });
  assert.deepEqual(expectedCouponForPromotion(fixed, "pro"), {
    percentOff: null,
    amountOff: 500,
    currency: "usd",
    duration: "repeating",
    durationInMonths: 1,
    metadata: { tomversePromotionId: "promo_1783819720812", planId: "pro" },
  });
  // The currency only matters when there is an amount to denominate.
  const wrongCurrency = couponMismatches({
    coupon: coupon({
      percentOff: null,
      amountOff: 500,
      currency: "eur",
      duration: "repeating",
      durationInMonths: 1,
    }),
    promotion: fixed,
    planId: "max",
    expectLiveMode: true,
  });
  assert.ok(describeMismatches(wrongCurrency).includes("identity:currency"));
});

test("a test-mode object stored against a live deployment is a mode mismatch", () => {
  const mismatches = codeMismatches({ livemode: false });
  assert.deepEqual(describeMismatches(mismatches), ["identity:livemode"]);
  assert.equal(canUseStripePromotionCode(mismatches), false);
  assert.equal(
    errorCodeForMismatches(mismatches),
    "PROMOTION_STRIPE_MODE_MISMATCH"
  );
});

test("an unrecognised key shape does not make every object look mismatched", () => {
  // A restricted or future key must not be able to take promotion checkout
  // down by declaring every stored object to be in the wrong mode.
  assert.equal(stripeKeyLiveMode("sk_live_abc"), true);
  assert.equal(stripeKeyLiveMode("rk_live_abc"), true);
  assert.equal(stripeKeyLiveMode("sk_test_abc"), false);
  assert.equal(stripeKeyLiveMode("whatever"), null);
  assert.equal(stripeKeyLiveMode(undefined), null);
  assert.deepEqual(
    codeMismatches({ livemode: false }, { expectLiveMode: null }),
    []
  );
});

test("a code belonging to a different promotion or plan is never adoptable", () => {
  assert.deepEqual(
    describeMismatches(
      codeMismatches({
        metadata: { tomversePromotionId: "promo_other", planId: "max" },
      })
    ),
    ["identity:metadata_promotion_id"]
  );
  // A plan stamp that does not match is reported as drift rather than identity
  // -- ownership is asserted by `tomversePromotionId`, and the strict reading
  // made a promotion eligible for two plans unusable on one of them (see
  // `planMetadataMismatch`). Adoption is what the strict severity was
  // protecting, and drift still blocks that.
  const otherPlan = codeMismatches({
    metadata: { tomversePromotionId: "promo_1783819720812", planId: "pro" },
  });
  assert.deepEqual(describeMismatches(otherPlan), [
    "drift:metadata_plan_id_stale",
  ]);
  assert.equal(canAdoptStripePromotionCode(otherPlan), false);
  assert.deepEqual(
    describeMismatches(codeMismatches({ couponId: "cpn_someone_else" })),
    ["identity:coupon_id"]
  );
});

test("promotion code strings compare case-insensitively, as Stripe treats them", () => {
  assert.deepEqual(codeMismatches({ code: "eddiefriend100" }), []);
  assert.deepEqual(
    describeMismatches(codeMismatches({ code: "EDDIEFRIEND10" })),
    ["identity:code"]
  );
});

test("inactive, expired, spent and customer-restricted codes are unusable but still ours", () => {
  for (const [overrides, reason] of [
    [{ active: false }, "usability:inactive"],
    [{ expiresAtSeconds: NOW_SECONDS - 1 }, "usability:expired"],
    [{ timesRedeemed: 1000 }, "usability:exhausted"],
    [{ customerId: "cus_someone_else" }, "usability:customer_restricted"],
  ]) {
    const mismatches = codeMismatches(overrides);
    assert.ok(
      describeMismatches(mismatches).includes(reason),
      `expected ${reason}`
    );
    assert.equal(canUseStripePromotionCode(mismatches), false);
    assert.equal(canAdoptStripePromotionCode(mismatches), false);
  }
});

test("a code reserved for this very customer is not a restriction conflict", () => {
  assert.deepEqual(codeMismatches({ customerId: "cus_current" }), []);
});

test("a cap that Stripe and the database disagree on is drift, not a failure", () => {
  // An operator raised maxRedemptions in the admin console and the Stripe cap
  // stayed where it was. Real, worth reporting -- but it has not denied anyone
  // anything, and failing checkout over it would be a self-inflicted outage.
  const mismatches = codeMismatches({ maxRedemptions: 10 });
  assert.deepEqual(describeMismatches(mismatches), ["drift:max_redemptions"]);
  assert.equal(canUseStripePromotionCode(mismatches), true);
  // Adoption is stricter: an unknown object has to prove it is ours.
  assert.equal(canAdoptStripePromotionCode(mismatches), false);
});

test("an expiry that disagrees with the policy is drift while it is still in the future", () => {
  const mismatches = codeMismatches({
    expiresAtSeconds: ENDS_AT_SECONDS + 86_400,
  });
  assert.deepEqual(describeMismatches(mismatches), ["drift:expires_at"]);
  assert.equal(canUseStripePromotionCode(mismatches), true);
});

test("a coupon whose discount drifted from the policy is fatal", () => {
  for (const overrides of [
    { percentOff: 50 },
    { duration: "once" },
    { durationInMonths: 3 },
    { valid: false },
  ]) {
    const mismatches = couponMismatchesFor(overrides);
    assert.ok(mismatches.length > 0, JSON.stringify(overrides));
    assert.equal(canUseStripePromotionCode(mismatches), false);
    assert.equal(
      errorCodeForMismatches(mismatches),
      "PROMOTION_COUPON_INVALID",
      JSON.stringify(overrides)
    );
  }
});

test("a coupon restricted to another product is a product mismatch, not a silent full-price charge", () => {
  // Left unchecked this is worse than a failure: Checkout succeeds and the
  // customer is billed the full price the promotion said they would not pay.
  const mismatches = couponMismatchesFor(
    { appliesToProducts: ["prod_something_else"] },
    { planProductId: "prod_max" }
  );
  assert.deepEqual(describeMismatches(mismatches), [
    "identity:applies_to_products",
  ]);
  assert.equal(
    errorCodeForMismatches(mismatches),
    "PROMOTION_PRODUCT_MISMATCH"
  );
  // Restricted to the right product is fine, and no restriction at all is fine.
  assert.deepEqual(
    couponMismatchesFor(
      { appliesToProducts: ["prod_max"] },
      { planProductId: "prod_max" }
    ),
    []
  );
  assert.deepEqual(couponMismatchesFor({ appliesToProducts: [] }), []);
});

test("mode mismatch outranks the other reasons it causes", () => {
  const mismatches = [
    ...codeMismatches({ livemode: false }),
    ...couponMismatchesFor({ valid: false }),
  ];
  assert.equal(
    errorCodeForMismatches(mismatches),
    "PROMOTION_STRIPE_MODE_MISMATCH"
  );
});

test("policy that Stripe cannot represent is caught before any network call", () => {
  assert.equal(promotionStripePolicyViolation(promotion()), null);
  assert.equal(
    promotionStripePolicyViolation(promotion({ durationMonths: 0 })),
    "duration_months_invalid"
  );
  assert.equal(
    promotionStripePolicyViolation(promotion({ durationMonths: 1.5 })),
    "duration_months_invalid"
  );
  assert.equal(
    promotionStripePolicyViolation(promotion({ maxRedemptions: null })),
    "max_redemptions_missing"
  );
  assert.equal(
    promotionStripePolicyViolation(promotion({ endsAt: null })),
    "ends_at_missing"
  );
  assert.equal(
    promotionStripePolicyViolation(
      promotion({ discountPercent: 0, discountAmountCents: null })
    ),
    "discount_missing"
  );
  assert.equal(
    promotionStripePolicyViolation(promotion({ discountPercent: 140 })),
    "discount_percent_out_of_range"
  );
});

test("provisioning idempotency keys are stable per policy and change when the policy does", () => {
  const first = promotionCouponIdempotencyKey(promotion(), "max");
  assert.equal(first, promotionCouponIdempotencyKey(promotion(), "max"));
  // A retry after a lost response must return the same object...
  assert.equal(
    promotionCodeIdempotencyKey(promotion(), "max"),
    promotionCodeIdempotencyKey(promotion(), "max")
  );
  // ...but an edited discount must not replay a create whose body no longer
  // matches what the policy now says.
  assert.notEqual(
    first,
    promotionCouponIdempotencyKey(promotion({ discountPercent: 50 }), "max")
  );
  assert.notEqual(first, promotionCouponIdempotencyKey(promotion(), "pro"));
  assert.notEqual(
    promotionPolicyVersion(promotion(), "max"),
    promotionPolicyVersion(
      promotion({ endsAt: "2026-09-01T00:00:00.000Z" }),
      "max"
    )
  );
  // No account identifier is reachable from a provisioning key.
  assert.ok(!first.includes("user"));
});

test("a checkout session key is per purchase attempt and hides the account", () => {
  const key = (purchaseAttemptId, userId = "user_abc") =>
    checkoutSessionIdempotencyKey({
      userId,
      purchaseAttemptId,
      secret: "deployment-secret",
    });
  // The same submission retried over a flaky network returns the same Session.
  assert.equal(key("attempt-1"), key("attempt-1"));
  // A second, deliberate attempt gets a new Session rather than a replay of one
  // that has since expired.
  assert.notEqual(key("attempt-1"), key("attempt-2"));
  // Two accounts cannot collide by choosing the same attempt id.
  assert.notEqual(key("attempt-1"), key("attempt-1", "user_xyz"));
  assert.ok(!key("attempt-1").includes("user_abc"));
});

test("a customer key is permanent per account, so a race cannot mint two customers", () => {
  const key = (userId) =>
    stripeCustomerIdempotencyKey({ userId, secret: "deployment-secret" });
  assert.equal(key("user_abc"), key("user_abc"));
  assert.notEqual(key("user_abc"), key("user_xyz"));
  assert.ok(!key("user_abc").includes("user_abc"));
});

test("Stripe errors are reduced to operator-safe facts, never the message", () => {
  const error = Object.assign(new Error("No such promotion_code: 'promo_x'"), {
    type: "StripeInvalidRequestError",
    code: "resource_missing",
    param: "promotion_code",
    requestId: "req_123",
    statusCode: 400,
  });
  const facts = stripeErrorFacts(error);
  assert.deepEqual(facts, {
    type: "StripeInvalidRequestError",
    code: "resource_missing",
    param: "promotion_code",
    requestId: "req_123",
    statusCode: 400,
  });
  assert.equal(isMissingResourceStripeError(facts), true);
  assert.equal(isRetryableStripeError(facts), false);
  // Nothing in the extracted facts quotes the object id the message leaked.
  assert.ok(!JSON.stringify(facts).includes("promo_x"));
});

test("outages are retryable and invalid requests are not", () => {
  assert.equal(
    isRetryableStripeError(stripeErrorFacts({ type: "StripeConnectionError" })),
    true
  );
  assert.equal(
    isRetryableStripeError(stripeErrorFacts({ type: "StripeRateLimitError" })),
    true
  );
  assert.equal(
    isRetryableStripeError(stripeErrorFacts({ statusCode: 503 })),
    true
  );
  assert.equal(
    isRetryableStripeError(stripeErrorFacts({ statusCode: 429 })),
    true
  );
  assert.equal(
    isRetryableStripeError(
      stripeErrorFacts({ type: "StripeInvalidRequestError", statusCode: 400 })
    ),
    false
  );
});

test("promotion configuration failures answer 4xx, and no branch leaks Stripe detail", () => {
  // A 500 tells the customer to try again and tells support nothing. These
  // cannot be fixed by retrying, so they are not reported as server faults.
  for (const code of [
    "PROMOTION_CODE_CONFLICT",
    "PROMOTION_COUPON_INVALID",
    "PROMOTION_PRODUCT_MISMATCH",
    "PROMOTION_STRIPE_MODE_MISMATCH",
  ]) {
    const external = externalCheckoutError(code);
    assert.equal(external.status, 400, code);
    assert.equal(external.code, "PROMOTION_UNAVAILABLE");
  }
  for (const code of [
    "PROMOTION_STRIPE_OBJECT_MISSING",
    "PROMOTION_PROVISIONING_FAILED",
    "CHECKOUT_PROVIDER_UNAVAILABLE",
  ]) {
    assert.equal(externalCheckoutError(code).status, 503, code);
  }
  assert.equal(
    externalCheckoutError("CHECKOUT_SESSION_CREATE_FAILED").status,
    500
  );
  // The customer-facing vocabulary never names Stripe or an internal object.
  for (const code of [
    "PROMOTION_CODE_CONFLICT",
    "PROMOTION_PROVISIONING_FAILED",
    "CHECKOUT_SESSION_CREATE_FAILED",
  ]) {
    const external = externalCheckoutError(code);
    assert.doesNotMatch(external.error, /stripe|coupon|promo_|cpn_|req_/i);
  }
});

test("mismatch descriptions carry reason slugs only", () => {
  const described = describeMismatches(codeMismatches({ livemode: false }));
  for (const entry of described) {
    assert.match(entry, /^(identity|usability|drift):[a-z_]+$/);
  }
});

/**
 * The plan stamped into a Stripe object's metadata.
 *
 * This is the rule behind the reported outage: EDDIEFRIEND100 validated, showed
 * -100% and A$0.00 in the order summary, and then refused at Checkout with
 * "This promotion is not currently available." A promotion eligible for two
 * plans has one Stripe Coupon and Promotion Code between them -- the row has
 * one linkage column pair and a Stripe promotion code string is unique across
 * the account -- so the object is stamped with whichever plan checked out
 * first, and treating that as an identity mismatch refuses the promotion on
 * every other eligible plan, permanently.
 */

const multiPlanPromotion = (planIds) =>
  promotion({ appliesToPlanIds: planIds });

test("a code stamped for the other eligible plan is not an identity failure", () => {
  const mismatches = promotionCodeMismatches({
    promotionCode: promotionCode({
      metadata: {
        tomversePromotionId: "promo_1783819720812",
        planId: "max",
      },
    }),
    promotion: multiPlanPromotion(["pro", "max"]),
    planId: "pro",
    expectLiveMode: true,
    expectedCouponId: "cpn_live",
    nowSeconds: NOW_SECONDS,
    customerId: null,
  });
  assert.deepEqual(describeMismatches(mismatches), []);
  assert.equal(canUseStripePromotionCode(mismatches), true);
});

test("the same relaxation applies to the coupon behind it", () => {
  const mismatches = couponMismatches({
    coupon: coupon({
      metadata: {
        tomversePromotionId: "promo_1783819720812",
        planId: "max",
      },
    }),
    promotion: multiPlanPromotion(["pro", "max"]),
    planId: "pro",
    expectLiveMode: true,
    planProductId: null,
  });
  assert.deepEqual(describeMismatches(mismatches), []);
});

test("the rule itself, branch by branch", () => {
  // Matching stamp, and a stamp naming another plan the row is eligible for:
  // both usable, because one Stripe object serves every plan on the row.
  assert.equal(planMetadataMismatch("pro", "pro", ["pro", "max"]), null);
  assert.equal(planMetadataMismatch("max", "pro", ["pro", "max"]), null);
  // No stamp at all: not an object this system created.
  assert.deepEqual(planMetadataMismatch(undefined, "pro", ["pro", "max"]), {
    reason: "metadata_plan_id",
    severity: "identity",
  });
  // A stamp naming a plan the row no longer covers: reported, not fatal.
  assert.deepEqual(planMetadataMismatch("max", "pro", ["pro"]), {
    reason: "metadata_plan_id_stale",
    severity: "drift",
  });
  // With no eligible list to consult, the plan being asked about is the only
  // one known to be eligible.
  assert.deepEqual(planMetadataMismatch("max", "pro", undefined), {
    reason: "metadata_plan_id_stale",
    severity: "drift",
  });
});

test("the reported outage: a missing stamp still produces the public error", () => {
  // The customer-facing string is unchanged, and still says nothing about
  // which of four internal causes produced it.
  const mismatches = promotionCodeMismatches({
    promotionCode: promotionCode({ metadata: {} }),
    promotion: multiPlanPromotion(["pro", "max"]),
    planId: "pro",
    expectLiveMode: true,
    expectedCouponId: "cpn_live",
    nowSeconds: NOW_SECONDS,
    customerId: null,
  });
  assert.equal(canUseStripePromotionCode(mismatches), false);
  assert.equal(errorCodeForMismatches(mismatches), "PROMOTION_CODE_CONFLICT");
  assert.equal(
    externalCheckoutError(errorCodeForMismatches(mismatches)).error,
    "This promotion is not currently available."
  );
});

test("an object carrying no plan stamp is still not ours", () => {
  const mismatches = promotionCodeMismatches({
    promotionCode: promotionCode({
      metadata: { tomversePromotionId: "promo_1783819720812" },
    }),
    promotion: multiPlanPromotion(["pro", "max"]),
    planId: "pro",
    expectLiveMode: true,
    expectedCouponId: "cpn_live",
    nowSeconds: NOW_SECONDS,
    customerId: null,
  });
  assert.ok(describeMismatches(mismatches).includes("identity:metadata_plan_id"));
});

test("a stamp naming a plan the row no longer covers is drift, not identity", () => {
  // The operator removed Max from the promotion after the object was created.
  // Ownership is not in doubt -- tomversePromotionId still matches -- so the
  // linked object keeps working while the disagreement is reported.
  const mismatches = promotionCodeMismatches({
    promotionCode: promotionCode({
      metadata: {
        tomversePromotionId: "promo_1783819720812",
        planId: "max",
      },
    }),
    promotion: multiPlanPromotion(["pro"]),
    planId: "pro",
    expectLiveMode: true,
    expectedCouponId: "cpn_live",
    nowSeconds: NOW_SECONDS,
    customerId: null,
  });
  assert.deepEqual(describeMismatches(mismatches), [
    "drift:metadata_plan_id_stale",
  ]);
  assert.equal(canUseStripePromotionCode(mismatches), true);
  // Stricter for an unknown object: drift still blocks adoption.
  assert.equal(canAdoptStripePromotionCode(mismatches), false);
});

test("the plan gate itself is untouched: a product restriction is still fatal", () => {
  // Relaxing the metadata stamp must not relax which plan a discount may be
  // charged against. `applies_to.products` is the Stripe-side restriction and
  // it stays an identity mismatch.
  const mismatches = couponMismatches({
    coupon: coupon({
      metadata: {
        tomversePromotionId: "promo_1783819720812",
        planId: "max",
      },
      appliesToProducts: ["prod_max_only"],
    }),
    promotion: multiPlanPromotion(["pro", "max"]),
    planId: "pro",
    expectLiveMode: true,
    planProductId: "prod_pro",
  });
  assert.deepEqual(describeMismatches(mismatches), [
    "identity:applies_to_products",
  ]);
  assert.equal(
    errorCodeForMismatches(mismatches),
    "PROMOTION_PRODUCT_MISMATCH"
  );
});

test("a stranger's code is still refused whatever its plan stamp says", () => {
  const mismatches = promotionCodeMismatches({
    promotionCode: promotionCode({
      metadata: { tomversePromotionId: "promo_someone_else", planId: "pro" },
    }),
    promotion: multiPlanPromotion(["pro", "max"]),
    planId: "pro",
    expectLiveMode: true,
    expectedCouponId: "cpn_live",
    nowSeconds: NOW_SECONDS,
    customerId: null,
  });
  assert.ok(
    describeMismatches(mismatches).includes("identity:metadata_promotion_id")
  );
  assert.equal(canUseStripePromotionCode(mismatches), false);
});
