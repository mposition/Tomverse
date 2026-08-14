import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCheckoutRequestPreview,
  collectReasonSlugs,
  evaluateAccountEligibility,
  evaluateLocalPolicy,
  evaluateStripeLinkage,
  recommendActions,
  summarizeDiagnostics,
} from "../lib/promotionDiagnosticsCore.ts";

/**
 * The Admin promotion diagnostics, as pure predicates.
 *
 * The states worth pinning here are the ones nobody can put a live account
 * into on purpose: a Stripe object stamped for the other plan, a coupon
 * restricted to the wrong product, a linkage the database records and Stripe
 * has forgotten. Reaching them by driving a real checkout means burning a
 * redemption on a capped promotion, which is the reason this feature exists.
 */

const NOW = new Date("2026-08-14T00:00:00.000Z");

const promotion = (overrides = {}) => ({
  id: "promo_eddie",
  code: "EDDIEFRIEND100",
  discountPercent: 100,
  discountAmountCents: null,
  durationMonths: 1,
  maxRedemptions: 1000,
  redeemedCount: 4,
  startsAt: "2026-07-01T00:00:00.000Z",
  endsAt: "2026-09-01T00:00:00.000Z",
  appliesToPlanIds: ["pro", "max"],
  allowAnnualStacking: false,
  isActive: true,
  fulfillmentType: "stripe_subscription",
  accessDurationDays: null,
  stripeCouponId: "cpn_x",
  stripePromotionCodeId: "promo_x",
  ...overrides,
});

const localPolicy = (overrides = {}, extra = {}) =>
  evaluateLocalPolicy({
    promotion: promotion(overrides),
    planId: "pro",
    billingInterval: "monthly",
    now: NOW,
    ...extra,
  });

const checkFor = (section, id) =>
  section.checks.find((item) => item.id === id) || null;

const healthyStripe = (overrides = {}) => ({
  expectLiveMode: true,
  storedCouponId: "cpn_x",
  storedCouponExists: true,
  storedCouponMismatches: [],
  storedPromotionCodeId: "promo_x",
  storedPromotionCodeExists: true,
  storedPromotionCodeMismatches: [],
  exactCodeCandidates: [
    {
      id: "promo_x",
      active: true,
      livemode: true,
      mismatches: [],
      adoptable: true,
    },
  ],
  recommendation: "healthy",
  ...overrides,
});

const stripeSection = (overrides = {}) =>
  evaluateStripeLinkage({
    stripeConfigured: true,
    facts: healthyStripe(overrides),
    internalPass: false,
  });

/* -------------------------------------------------------------------------- */
/* Local policy                                                                */
/* -------------------------------------------------------------------------- */

test("a healthy promotion passes every local policy check", () => {
  const section = localPolicy();
  assert.equal(section.status, "pass");
  assert.equal(section.blockingReason, null);
  assert.ok(section.checks.every((item) => item.status === "pass"));
});

test("an inactive promotion fails on activity", () => {
  const section = localPolicy({ isActive: false });
  assert.equal(section.status, "fail");
  assert.equal(checkFor(section, "active").status, "fail");
  assert.equal(section.blockingReason, "unavailable");
});

test("a promotion that has not started, and one that has expired", () => {
  const notStarted = localPolicy({ startsAt: "2026-12-01T00:00:00.000Z" });
  assert.equal(checkFor(notStarted, "schedule_window").reason, "not_started");
  assert.equal(notStarted.blockingReason, "not_started");

  const expired = localPolicy({ endsAt: "2026-08-01T00:00:00.000Z" });
  assert.equal(checkFor(expired, "schedule_window").reason, "expired");
  assert.equal(expired.blockingReason, "expired");
});

test("an exhausted redemption cap is a failure, not a warning", () => {
  const section = localPolicy({ maxRedemptions: 4, redeemedCount: 4 });
  assert.equal(checkFor(section, "redemption_cap").reason, "redemption_limit_reached");
  assert.equal(section.blockingReason, "redemption_limit");
});

test("a plan the promotion does not cover fails on plan eligibility", () => {
  const section = evaluateLocalPolicy({
    promotion: promotion({ appliesToPlanIds: ["max"] }),
    planId: "pro",
    billingInterval: "monthly",
    now: NOW,
  });
  assert.equal(checkFor(section, "selected_plan_eligibility").status, "fail");
  assert.equal(section.blockingReason, "plan_not_eligible");
});

test("annual billing without stacking permission is refused", () => {
  const section = evaluateLocalPolicy({
    promotion: promotion(),
    planId: "pro",
    billingInterval: "annual",
    now: NOW,
  });
  assert.equal(checkFor(section, "annual_stacking_eligibility").status, "fail");
  assert.equal(section.blockingReason, "annual_not_allowed");
});

test("a promotion Stripe cannot represent is caught even when eligibility passes", () => {
  // `promotionStripePolicyViolation` runs ahead of any Stripe call, so this is
  // a checkout failure the eligibility gate alone never sees.
  const section = localPolicy({ durationMonths: 0 });
  assert.equal(checkFor(section, "stripe_representable").reason, "duration_months_invalid");
  assert.equal(section.status, "fail");
});

test("the eligibility gate always wins over the display breakdown", () => {
  // The breakdown is presentation. If it ever scores everything as passing
  // while the gate refuses, the refusal is still reported: a tool that can
  // print "ready" over a live refusal is worse than no tool.
  const section = evaluateLocalPolicy({
    promotion: promotion({ fulfillmentType: "internal_pass", accessDurationDays: 60 }),
    planId: "pro",
    billingInterval: "monthly",
    now: NOW,
  });
  assert.equal(section.blockingReason, null);
  const broken = evaluateLocalPolicy({
    promotion: promotion({
      fulfillmentType: "internal_pass",
      accessDurationDays: 0,
    }),
    planId: "pro",
    billingInterval: "monthly",
    now: NOW,
  });
  assert.equal(broken.blockingReason, "unavailable");
  assert.equal(broken.status, "fail");
});

/* -------------------------------------------------------------------------- */
/* Account eligibility                                                         */
/* -------------------------------------------------------------------------- */

const account = (overrides = {}) => ({
  exists: true,
  effectivePlan: "Free",
  storedPlan: "Free",
  hasStripeSubscription: false,
  subscriptionStatus: null,
  alreadyRedeemed: false,
  ...overrides,
});

test("no account selected leaves the account checks not evaluated", () => {
  const section = evaluateAccountEligibility({ account: null, planId: "pro" });
  assert.equal(section.evaluated, false);
  assert.equal(section.status, "not_checked");
  assert.deepEqual(section.checks, [
    { id: "account", status: "not_checked", reason: "no_account_selected" },
  ]);
  assert.equal(section.planBlock, null);
});

test("an existing account that already redeemed this promotion is blocked", () => {
  const section = evaluateAccountEligibility({
    account: account({ alreadyRedeemed: true }),
    planId: "pro",
  });
  assert.equal(checkFor(section, "already_redeemed").reason, "already_used");
  assert.equal(section.status, "fail");
});

test("the three checkout plan refusals are reported, not re-derived", () => {
  const samePlan = evaluateAccountEligibility({
    account: account({ effectivePlan: "Pro" }),
    planId: "pro",
  });
  assert.equal(samePlan.planBlock.code, "PLAN_CHANGE_NOT_SUPPORTED");
  assert.equal(samePlan.planBlock.reason, "same_plan");

  const downgrade = evaluateAccountEligibility({
    account: account({ effectivePlan: "Max" }),
    planId: "pro",
  });
  assert.equal(downgrade.planBlock.reason, "downgrade");

  const active = evaluateAccountEligibility({
    account: account({
      effectivePlan: "Pro",
      hasStripeSubscription: true,
      subscriptionStatus: "active",
    }),
    planId: "max",
  });
  assert.equal(active.planBlock.code, "ACTIVE_SUBSCRIPTION_EXISTS");
});

test("a missing account is reported as missing rather than as eligible", () => {
  const section = evaluateAccountEligibility({
    account: account({ exists: false }),
    planId: "pro",
  });
  assert.equal(section.status, "fail");
  assert.equal(checkFor(section, "user_exists").reason, "user_not_found");
});

/* -------------------------------------------------------------------------- */
/* Stripe linkage                                                              */
/* -------------------------------------------------------------------------- */

test("an unconfigured Stripe leaves the linkage not checked, not failed", () => {
  const section = evaluateStripeLinkage({
    stripeConfigured: false,
    facts: null,
    internalPass: false,
  });
  assert.equal(section.status, "not_checked");
  assert.equal(section.checks[0].reason, "stripe_not_configured");
  assert.deepEqual(section.blockingReasons, []);
});

test("an internal pass never reaches Stripe, so no Stripe verdict is invented", () => {
  const section = evaluateStripeLinkage({
    stripeConfigured: true,
    facts: healthyStripe(),
    internalPass: true,
  });
  assert.equal(section.status, "not_checked");
  assert.equal(section.checks[0].reason, "internal_pass_fulfillment");
});

test("a healthy linkage passes", () => {
  assert.equal(stripeSection().status, "pass");
});

test("a live/test mode mismatch is a blocker and names itself", () => {
  const section = stripeSection({
    storedPromotionCodeMismatches: ["identity:livemode"],
  });
  assert.equal(section.status, "fail");
  assert.equal(checkFor(section, "stripe_mode").status, "fail");
  assert.ok(section.blockingReasons.includes("identity:livemode"));
});

test("a coupon restricted to another plan's product is a product mismatch", () => {
  const section = stripeSection({
    storedPromotionCodeMismatches: ["identity:applies_to_products"],
  });
  assert.equal(checkFor(section, "product_restriction").status, "fail");
});

test("a coupon whose discount or duration drifted is a blocker", () => {
  for (const reason of [
    "identity:percent_off",
    "identity:duration_in_months",
    "usability:coupon_invalid",
  ]) {
    const section = stripeSection({ storedPromotionCodeMismatches: [reason] });
    assert.equal(section.status, "fail", reason);
    assert.equal(checkFor(section, "stored_linkage").reason, "stored_linkage_fatal_mismatch");
  }
});

test("a stale database linkage is a warning, because checkout adopts", () => {
  const section = stripeSection({
    storedPromotionCodeExists: false,
    recommendation: "relink_stored_object",
  });
  assert.equal(section.status, "warn");
  assert.equal(
    checkFor(section, "stored_linkage").reason,
    "stored_object_missing_in_stripe"
  );
});

test("a stored object that no longer matches is a blocker even when another is adoptable", () => {
  // `inspectStripePromotionLinkage` recommends "adopt_exact_match" here, but
  // `ensureStripePromotionDiscount` throws on the linked object and never
  // reaches adoption. Reporting the recommendation as the verdict would tell
  // an operator that checkout will recover on its own. It will not.
  const section = stripeSection({
    storedPromotionCodeMismatches: ["identity:metadata_promotion_id"],
    recommendation: "adopt_exact_match",
    exactCodeCandidates: [
      {
        id: "promo_other",
        active: true,
        livemode: true,
        mismatches: [],
        adoptable: true,
      },
    ],
  });
  assert.equal(section.status, "fail");
  assert.equal(
    checkFor(section, "stored_linkage").reason,
    "stored_linkage_fatal_mismatch"
  );
});

test("an active code owned by another object is a blocker requiring review", () => {
  const section = stripeSection({
    storedPromotionCodeId: null,
    storedPromotionCodeExists: false,
    storedPromotionCodeMismatches: [],
    exactCodeCandidates: [
      {
        id: "promo_stranger",
        active: true,
        livemode: true,
        mismatches: ["identity:metadata_promotion_id"],
        adoptable: false,
      },
    ],
    recommendation: "manual_review",
  });
  assert.equal(section.status, "fail");
  assert.equal(
    checkFor(section, "exact_code_candidates").reason,
    "active_code_owned_by_another_object"
  );
  const actions = recommendActions({
    localPolicy: localPolicy(),
    account: evaluateAccountEligibility({ account: null, planId: "pro" }),
    stripe: section,
    checkoutPreview: buildCheckoutRequestPreview({
      promotion: promotion(),
      currency: "USD",
      baseAmountMinor: 1500,
      discountResolvable: false,
    }),
  });
  assert.ok(
    actions.some(
      (item) => item.id === "conflicting_active_code_requires_operator_review"
    )
  );
});

test("drift alone is a warning, never a blocker", () => {
  const section = stripeSection({
    storedPromotionCodeMismatches: [
      "drift:max_redemptions",
      "drift:metadata_plan_id_stale",
    ],
  });
  assert.equal(section.status, "warn");
  assert.deepEqual(section.blockingReasons, []);
  assert.equal(section.driftReasons.length, 2);
});

test("nothing in Stripe yet is a warning: the first real checkout provisions it", () => {
  const section = stripeSection({
    storedCouponId: null,
    storedPromotionCodeId: null,
    storedPromotionCodeExists: false,
    exactCodeCandidates: [],
    recommendation: "create_missing_objects",
  });
  assert.equal(section.status, "warn");
});

/* -------------------------------------------------------------------------- */
/* Checkout request preview                                                    */
/* -------------------------------------------------------------------------- */

test("a resolvable discount sends discounts and omits allow_promotion_codes", () => {
  const preview = buildCheckoutRequestPreview({
    promotion: promotion(),
    currency: "AUD",
    baseAmountMinor: 2400,
    discountResolvable: true,
  });
  assert.equal(preview.discountsParamSent, true);
  assert.equal(preview.allowPromotionCodesParam, "omitted");
  assert.equal(preview.bothDiscountParamsSent, false);
  assert.equal(preview.discountedAmountMinor, 0);
  assert.equal(preview.expectedDiscountSource, "stripe_promotion_code");
  assert.equal(preview.sessionCreated, false);
});

test("no discount means allow_promotion_codes is sent explicitly false", () => {
  const preview = buildCheckoutRequestPreview({
    promotion: promotion(),
    currency: "USD",
    baseAmountMinor: 1500,
    discountResolvable: false,
  });
  assert.equal(preview.discountsParamSent, false);
  assert.equal(preview.allowPromotionCodesParam, "false");
});

test("sending both discount parameters is a blocker on its own", () => {
  // Stripe checks that the parameters are *present*, not what they are set to,
  // so `false` beside a discount is the same 400 as `true`.
  const preview = {
    ...buildCheckoutRequestPreview({
      promotion: promotion(),
      currency: "USD",
      baseAmountMinor: 1500,
      discountResolvable: true,
    }),
    allowPromotionCodesParam: "false",
    bothDiscountParamsSent: true,
  };
  const status = summarizeDiagnostics({
    localPolicy: localPolicy(),
    account: evaluateAccountEligibility({ account: null, planId: "pro" }),
    stripe: stripeSection(),
    checkoutPreview: preview,
  });
  assert.equal(status, "blocked");
  assert.ok(
    recommendActions({
      localPolicy: localPolicy(),
      account: evaluateAccountEligibility({ account: null, planId: "pro" }),
      stripe: stripeSection(),
      checkoutPreview: preview,
    }).some((item) => item.id === "verify_deployment_sha")
  );
});

test("an internal pass needs no payment method and does not renew", () => {
  const preview = buildCheckoutRequestPreview({
    promotion: promotion({
      fulfillmentType: "internal_pass",
      accessDurationDays: 60,
    }),
    currency: "USD",
    baseAmountMinor: 1500,
    discountResolvable: true,
  });
  assert.equal(preview.paymentMethodRequired, false);
  assert.equal(preview.automaticRenewal, false);
  assert.equal(preview.expectedDiscountSource, "internal_pass");
  assert.equal(preview.discountsParamSent, false);
});

/* -------------------------------------------------------------------------- */
/* Summary and reasons                                                         */
/* -------------------------------------------------------------------------- */

test("a configuration-only run with a healthy promotion is ready", () => {
  const sections = {
    localPolicy: localPolicy(),
    account: evaluateAccountEligibility({ account: null, planId: "pro" }),
    stripe: stripeSection(),
    checkoutPreview: buildCheckoutRequestPreview({
      promotion: promotion(),
      currency: "USD",
      baseAmountMinor: 1500,
      discountResolvable: true,
    }),
  };
  assert.equal(summarizeDiagnostics(sections), "ready");
  assert.deepEqual(recommendActions(sections), [
    { id: "no_action_required", severity: "info" },
  ]);
  assert.deepEqual(collectReasonSlugs(sections), []);
});

test("any failing section blocks the whole run", () => {
  assert.equal(
    summarizeDiagnostics({
      localPolicy: localPolicy({ isActive: false }),
      account: evaluateAccountEligibility({ account: null, planId: "pro" }),
      stripe: stripeSection(),
      checkoutPreview: buildCheckoutRequestPreview({
        promotion: promotion(),
        currency: "USD",
        baseAmountMinor: 1500,
        discountResolvable: true,
      }),
    }),
    "blocked"
  );
});

test("reason slugs collect every failure and warning, and nothing that passed", () => {
  const sections = {
    localPolicy: localPolicy({ isActive: false }),
    account: evaluateAccountEligibility({
      account: account({ alreadyRedeemed: true }),
      planId: "pro",
    }),
    stripe: stripeSection({
      storedPromotionCodeMismatches: ["drift:max_redemptions"],
    }),
  };
  const slugs = collectReasonSlugs(sections);
  assert.ok(slugs.includes("promotion_inactive"));
  assert.ok(slugs.includes("already_used"));
  assert.equal(new Set(slugs).size, slugs.length);
});

test("a hand-made stored coupon is a blocker, not a missing object", () => {
  // The staging state on 2026-08-14: a coupon created in the Stripe dashboard
  // with `duration: once` and no metadata, stored against the promotion. The
  // linkage report used to call this "create_missing_objects".
  const section = stripeSection({
    storedPromotionCodeId: null,
    storedPromotionCodeExists: false,
    exactCodeCandidates: [],
    recommendation: "manual_review",
    storedCouponMismatches: [
      "identity:duration",
      "identity:duration_in_months",
      "identity:metadata_promotion_id",
    ],
  });
  assert.equal(section.status, "fail");
  assert.equal(checkFor(section, "stored_coupon").reason, "stored_coupon_mismatch");
  assert.ok(section.blockingReasons.includes("identity:duration"));
  assert.ok(
    recommendActions({
      localPolicy: localPolicy(),
      account: evaluateAccountEligibility({ account: null, planId: "pro" }),
      stripe: section,
      checkoutPreview: buildCheckoutRequestPreview({
        promotion: promotion(),
        currency: "USD",
        baseAmountMinor: 1500,
        discountResolvable: false,
      }),
    }).some(
      (item) => item.id === "conflicting_active_code_requires_operator_review"
    )
  );
});

test("a stored coupon Stripe has forgotten is only a warning", () => {
  const section = stripeSection({ storedCouponExists: false });
  assert.equal(section.status, "warn");
  assert.equal(
    checkFor(section, "stored_coupon").reason,
    "stored_coupon_missing_in_stripe"
  );
  assert.deepEqual(section.blockingReasons, []);
});

test("no stored coupon at all is a warning, not a failure", () => {
  const section = stripeSection({
    storedCouponId: null,
    storedCouponExists: false,
  });
  assert.equal(checkFor(section, "stored_coupon").reason, "no_stored_coupon");
});
