/**
 * Pure decision layer for the Admin "Promotion diagnostics" panel.
 *
 * The question it answers is the one nobody could answer without creating a
 * throwaway account: a promotion validates, the order summary shows the
 * discount, and pressing "Continue to payment" comes back with "This promotion
 * is not currently available." Validation and Checkout disagree because they
 * read different things -- validation reads the policy row, Checkout also
 * reconciles the Stripe Coupon and Promotion Code behind it -- and the public
 * error is deliberately identical across four different internal causes.
 *
 * Everything here is a function of plain data: no Stripe client, no Prisma, no
 * clock of its own, no `Request`. That last one matters. Calling the existing
 * `validatePromotionForCheckout()` from an Admin route would hash the
 * *operator's* IP as though it were the customer's and let a support session
 * contribute to the shared-IP abuse signal, so the abuse layer is reported as
 * not evaluated instead of being evaluated wrongly.
 *
 * `lib/promotionDiagnostics.ts` owns the reads and calls into this.
 */

import {
  promotionEligibilityFailure,
  promotionDiscountedMinor,
  type PromotionValidationReason,
} from "@/lib/billingPromotionCore";
import {
  checkoutPlanEligibilityBlock,
  type CheckoutPlanBlock,
  type CheckoutPlanTier,
} from "@/lib/checkoutPlanEligibilityCore";
import {
  promotionStripePolicyViolation,
  type PromotionPolicyInput,
} from "@/lib/stripePromotionProvisioningCore";

export type DiagnosticStatus = "pass" | "fail" | "warn" | "not_checked";

/**
 * One named observation.
 *
 * `reason` is a machine slug, and it is Admin-only: the customer-facing
 * Checkout response says "This promotion is not currently available." and keeps
 * saying exactly that. Naming the internal cause outward would tell an attacker
 * which of four configuration seams they had just probed.
 */
export type DiagnosticCheck = {
  id: string;
  status: DiagnosticStatus;
  reason: string | null;
};

export type DiagnosticsStatus = "ready" | "blocked" | "warning" | "not_checked";

const check = (
  id: string,
  status: DiagnosticStatus,
  reason: string | null = null
): DiagnosticCheck => ({ id, status, reason });

export type DiagnosticsPromotion = PromotionPolicyInput & {
  isActive: boolean;
  redeemedCount: number;
  startsAt: string | null;
  appliesToPlanIds: readonly string[];
  allowAnnualStacking: boolean;
  fulfillmentType: "stripe_subscription" | "internal_pass";
  accessDurationDays: number | null;
  stripeCouponId: string | null;
  stripePromotionCodeId: string | null;
};

export type DiagnosticsPlanId = "pro" | "max";
export type DiagnosticsInterval = "monthly" | "annual";

/* -------------------------------------------------------------------------- */
/* Local policy                                                                */
/* -------------------------------------------------------------------------- */

export type LocalPolicySection = {
  status: DiagnosticStatus;
  checks: DiagnosticCheck[];
  /**
   * The verdict of the function Checkout itself calls. Authoritative: the
   * per-field breakdown above is presentation, and if the two ever disagree the
   * breakdown is the one that is wrong.
   */
  blockingReason: PromotionValidationReason | null;
};

/** Which display check a `promotionEligibilityFailure` reason belongs to. */
const REASON_TO_CHECK: Partial<Record<PromotionValidationReason, string>> = {
  unavailable: "active",
  not_started: "schedule_window",
  expired: "schedule_window",
  redemption_limit: "redemption_cap",
  plan_not_eligible: "selected_plan_eligibility",
  annual_not_allowed: "annual_stacking_eligibility",
};

export const evaluateLocalPolicy = ({
  promotion,
  planId,
  billingInterval,
  now,
}: {
  promotion: DiagnosticsPromotion;
  planId: DiagnosticsPlanId;
  billingInterval: DiagnosticsInterval;
  now: Date;
}): LocalPolicySection => {
  const startsAt = promotion.startsAt ? new Date(promotion.startsAt) : null;
  const endsAt = promotion.endsAt ? new Date(promotion.endsAt) : null;
  const hasDiscount =
    promotion.discountPercent > 0 ||
    Boolean(promotion.discountAmountCents && promotion.discountAmountCents > 0);
  const internalPassShapeValid =
    promotion.fulfillmentType !== "internal_pass" ||
    (promotion.discountPercent === 100 &&
      Number.isSafeInteger(promotion.accessDurationDays) &&
      (promotion.accessDurationDays || 0) > 0 &&
      (promotion.accessDurationDays || 0) <= 366);

  const checks: DiagnosticCheck[] = [
    promotion.isActive
      ? check("active", "pass")
      : check("active", "fail", "promotion_inactive"),
    !endsAt
      ? check("schedule_window", "fail", "ends_at_missing")
      : startsAt && startsAt > now
        ? check("schedule_window", "fail", "not_started")
        : endsAt <= now
          ? check("schedule_window", "fail", "expired")
          : check("schedule_window", "pass"),
    promotion.maxRedemptions === null || promotion.maxRedemptions <= 0
      ? check("redemption_cap", "fail", "max_redemptions_missing")
      : promotion.redeemedCount >= promotion.maxRedemptions
        ? check("redemption_cap", "fail", "redemption_limit_reached")
        : check("redemption_cap", "pass"),
    hasDiscount
      ? check("discount_shape", "pass")
      : check("discount_shape", "fail", "discount_missing"),
    internalPassShapeValid
      ? check("fulfillment_policy", "pass")
      : check("fulfillment_policy", "fail", "internal_pass_policy_invalid"),
    promotion.appliesToPlanIds.includes(planId)
      ? check("selected_plan_eligibility", "pass")
      : check("selected_plan_eligibility", "fail", "plan_not_eligible"),
    billingInterval === "annual" && !promotion.allowAnnualStacking
      ? check("annual_stacking_eligibility", "fail", "annual_not_allowed")
      : check("annual_stacking_eligibility", "pass"),
  ];

  // The policy shape Stripe itself has to be able to represent. Checked before
  // any network call by `ensureStripePromotionDiscount`, so a violation here is
  // a Checkout failure that never reaches Stripe at all -- and one the local
  // eligibility gate does not catch.
  const stripeShapeViolation =
    promotion.fulfillmentType === "internal_pass"
      ? null
      : promotionStripePolicyViolation(promotion);
  checks.push(
    stripeShapeViolation
      ? check("stripe_representable", "fail", stripeShapeViolation)
      : check("stripe_representable", "pass")
  );

  const blockingReason = promotionEligibilityFailure({
    promotion: {
      isActive: promotion.isActive,
      maxRedemptions: promotion.maxRedemptions,
      redeemedCount: promotion.redeemedCount,
      startsAt: promotion.startsAt,
      endsAt: promotion.endsAt,
      appliesToPlanIds: [...promotion.appliesToPlanIds],
      allowAnnualStacking: promotion.allowAnnualStacking,
      discountPercent: promotion.discountPercent,
      discountAmountCents: promotion.discountAmountCents,
      fulfillmentType: promotion.fulfillmentType,
      accessDurationDays: promotion.accessDurationDays,
    },
    planId,
    billingInterval,
    now,
  });

  // The gate wins. If it refuses for something the breakdown scored as passing,
  // the refusal is still reported -- a diagnostics tool that can print "ready"
  // over a live refusal is worse than no tool.
  if (blockingReason) {
    const targetId = REASON_TO_CHECK[blockingReason];
    const target = targetId
      ? checks.find((item) => item.id === targetId)
      : undefined;
    if (target && target.status === "pass") {
      target.status = "fail";
      target.reason = blockingReason;
    } else if (!checks.some((item) => item.status === "fail")) {
      checks.push(check("policy_gate", "fail", blockingReason));
    }
  }

  return {
    status: checks.some((item) => item.status === "fail") ? "fail" : "pass",
    checks,
    blockingReason,
  };
};

/* -------------------------------------------------------------------------- */
/* Account eligibility                                                         */
/* -------------------------------------------------------------------------- */

export type DiagnosticsAccount = {
  exists: boolean;
  /** The plan the account can actually use now, not the raw column. */
  effectivePlan: CheckoutPlanTier;
  storedPlan: CheckoutPlanTier;
  hasStripeSubscription: boolean;
  subscriptionStatus: string | null;
  alreadyRedeemed: boolean;
};

export type AccountSection = {
  evaluated: boolean;
  status: DiagnosticStatus;
  checks: DiagnosticCheck[];
  planBlock: CheckoutPlanBlock | null;
};

export const evaluateAccountEligibility = ({
  account,
  planId,
}: {
  account: DiagnosticsAccount | null;
  planId: DiagnosticsPlanId;
}): AccountSection => {
  if (!account) {
    return {
      evaluated: false,
      status: "not_checked",
      checks: [check("account", "not_checked", "no_account_selected")],
      planBlock: null,
    };
  }
  if (!account.exists) {
    return {
      evaluated: true,
      status: "fail",
      checks: [check("user_exists", "fail", "user_not_found")],
      planBlock: null,
    };
  }

  const targetTier: CheckoutPlanTier = planId === "max" ? "Max" : "Pro";
  // The same function `/api/billing/checkout` runs, so the console cannot
  // report an account as ready for a checkout the server would refuse at 409.
  const planBlock = checkoutPlanEligibilityBlock({
    effectivePlan: account.effectivePlan,
    targetTier,
    hasStripeSubscription: account.hasStripeSubscription,
    subscriptionStatus: account.subscriptionStatus,
  });

  const checks: DiagnosticCheck[] = [
    check("user_exists", "pass"),
    account.alreadyRedeemed
      ? check("already_redeemed", "fail", "already_used")
      : check("already_redeemed", "pass"),
    planBlock
      ? check("plan_change_block", "fail", planBlock.reason)
      : check("plan_change_block", "pass"),
  ];

  return {
    evaluated: true,
    status: checks.some((item) => item.status === "fail") ? "fail" : "pass",
    checks,
    planBlock,
  };
};

/* -------------------------------------------------------------------------- */
/* Stripe linkage                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The subset of `PromotionLinkageReport` this layer judges, restated so the
 * core stays free of the server-only provisioning module.
 */
export type StripeLinkageFacts = {
  expectLiveMode: boolean | null;
  storedCouponId: string | null;
  storedCouponExists: boolean;
  storedCouponMismatches: string[];
  storedPromotionCodeId: string | null;
  storedPromotionCodeExists: boolean;
  storedPromotionCodeMismatches: string[];
  exactCodeCandidates: {
    id: string;
    active: boolean;
    livemode: boolean;
    mismatches: string[];
    adoptable: boolean;
  }[];
  recommendation:
    | "healthy"
    | "relink_stored_object"
    | "adopt_exact_match"
    | "create_missing_objects"
    | "manual_review";
};

export type StripeSection = {
  status: DiagnosticStatus;
  checks: DiagnosticCheck[];
  facts: StripeLinkageFacts | null;
  /** Reason slugs that would fail the checkout, most specific first. */
  blockingReasons: string[];
  driftReasons: string[];
};

const severityOf = (describedMismatch: string) =>
  describedMismatch.split(":")[0] || "";

export const evaluateStripeLinkage = ({
  stripeConfigured,
  facts,
  internalPass,
}: {
  stripeConfigured: boolean;
  facts: StripeLinkageFacts | null;
  internalPass: boolean;
}): StripeSection => {
  // An internal pass never reaches Stripe: `/api/billing/checkout` grants the
  // access period itself and returns a redirect. Reporting a Stripe verdict for
  // it would invent a dependency the fulfilment path does not have.
  if (internalPass) {
    return {
      status: "not_checked",
      checks: [check("stripe_linkage", "not_checked", "internal_pass_fulfillment")],
      facts: null,
      blockingReasons: [],
      driftReasons: [],
    };
  }
  if (!stripeConfigured || !facts) {
    return {
      status: "not_checked",
      checks: [check("stripe_linkage", "not_checked", "stripe_not_configured")],
      facts: null,
      blockingReasons: [],
      driftReasons: [],
    };
  }

  const checks: DiagnosticCheck[] = [];
  const blockingReasons: string[] = [];
  const driftReasons: string[] = [];

  // The coupon comes first because `ensureCoupon()` reaches it first. A stored
  // coupon that exists and no longer matches is a hard stop regardless of what
  // the promotion code looks like -- and it is the one state the linkage
  // report used to miss entirely, reporting "nothing in Stripe yet" over a
  // coupon that was about to refuse every checkout.
  const couponFatal = facts.storedCouponMismatches.filter(
    (item) => severityOf(item) !== "drift"
  );
  driftReasons.push(
    ...facts.storedCouponMismatches.filter(
      (item) => severityOf(item) === "drift"
    )
  );
  if (!facts.storedCouponId) {
    checks.push(check("stored_coupon", "warn", "no_stored_coupon"));
  } else if (!facts.storedCouponExists) {
    // Recoverable on its own: the coupon is ours to re-create, and
    // `ensureCoupon()` does so under a stable idempotency key.
    checks.push(check("stored_coupon", "warn", "stored_coupon_missing_in_stripe"));
  } else if (couponFatal.length > 0) {
    checks.push(check("stored_coupon", "fail", "stored_coupon_mismatch"));
    blockingReasons.push(...couponFatal);
  } else {
    checks.push(check("stored_coupon", "pass"));
  }

  const storedFatal = facts.storedPromotionCodeMismatches.filter(
    (item) => severityOf(item) !== "drift"
  );
  const storedDrift = facts.storedPromotionCodeMismatches.filter(
    (item) => severityOf(item) === "drift"
  );
  driftReasons.push(...storedDrift);

  if (!facts.storedPromotionCodeId) {
    checks.push(check("stored_linkage", "warn", "no_stored_promotion_code"));
  } else if (!facts.storedPromotionCodeExists) {
    checks.push(check("stored_linkage", "warn", "stored_object_missing_in_stripe"));
  } else if (storedFatal.length > 0) {
    // The decisive case, and the one `inspectStripePromotionLinkage`'s own
    // recommendation understates: `ensureStripePromotionDiscount` throws on a
    // linked object that no longer matches and never falls through to adopting
    // a different one. So an "adopt_exact_match" recommendation here does not
    // mean checkout will recover -- it means an operator has to move the
    // linkage first.
    checks.push(check("stored_linkage", "fail", "stored_linkage_fatal_mismatch"));
    blockingReasons.push(...storedFatal);
  } else {
    checks.push(check("stored_linkage", "pass"));
  }

  const adoptable = facts.exactCodeCandidates.filter((item) => item.adoptable);
  const activeRejected = facts.exactCodeCandidates.filter(
    (item) => !item.adoptable && item.active
  );

  if (facts.exactCodeCandidates.length === 0) {
    checks.push(
      check("exact_code_candidates", "warn", "no_stripe_object_for_code")
    );
  } else if (adoptable.length === 1) {
    checks.push(check("exact_code_candidates", "pass"));
  } else if (adoptable.length > 1) {
    checks.push(
      check("exact_code_candidates", "fail", "multiple_adoptable_codes")
    );
    blockingReasons.push("identity:multiple_adoptable_codes");
  } else {
    checks.push(
      check(
        "exact_code_candidates",
        activeRejected.length > 0 ? "fail" : "warn",
        activeRejected.length > 0
          ? "active_code_owned_by_another_object"
          : "only_inactive_candidates"
      )
    );
    if (activeRejected.length > 0) {
      blockingReasons.push(
        ...activeRejected.flatMap((item) =>
          item.mismatches.filter((entry) => severityOf(entry) !== "drift")
        )
      );
    }
  }

  const modeMismatch = blockingReasons.some((item) =>
    item.endsWith(":livemode")
  );
  const productMismatch = blockingReasons.some((item) =>
    item.endsWith(":applies_to_products")
  );
  checks.push(
    modeMismatch
      ? check("stripe_mode", "fail", "livemode_mismatch")
      : check("stripe_mode", "pass")
  );
  checks.push(
    productMismatch
      ? check("product_restriction", "fail", "applies_to_products")
      : check("product_restriction", "pass")
  );

  const status = checks.some((item) => item.status === "fail")
    ? "fail"
    : checks.some((item) => item.status === "warn") || driftReasons.length > 0
      ? "warn"
      : "pass";

  return {
    status,
    checks,
    facts,
    blockingReasons: Array.from(new Set(blockingReasons)),
    driftReasons: Array.from(new Set(driftReasons)),
  };
};

/* -------------------------------------------------------------------------- */
/* Checkout request preview                                                    */
/* -------------------------------------------------------------------------- */

export type CheckoutRequestPreview = {
  currency: string;
  baseAmountMinor: number;
  discountedAmountMinor: number;
  expectedDiscountSource: "stripe_promotion_code" | "internal_pass" | "none";
  /** Whether the Session request would carry `discounts`. */
  discountsParamSent: boolean;
  /** What the Session request would do with `allow_promotion_codes`. */
  allowPromotionCodesParam: "omitted" | "false";
  /**
   * Stripe refuses a Session carrying both parameters -- it checks that they
   * are *present*, not what they are set to, so `false` beside a discount is
   * the same 400 as `true`. A preview that predicts both is a blocker on its
   * own, independently of anything the promotion says.
   */
  bothDiscountParamsSent: boolean;
  paymentMethodRequired: boolean;
  automaticRenewal: boolean;
  sessionCreated: false;
};

export const buildCheckoutRequestPreview = ({
  promotion,
  currency,
  baseAmountMinor,
  discountResolvable,
}: {
  promotion: DiagnosticsPromotion;
  currency: string;
  baseAmountMinor: number;
  /** Whether the Stripe layer could hand Checkout a discount right now. */
  discountResolvable: boolean;
}): CheckoutRequestPreview => {
  const internalPass = promotion.fulfillmentType === "internal_pass";
  const discountsParamSent = !internalPass && discountResolvable;
  return {
    currency,
    baseAmountMinor,
    discountedAmountMinor: promotionDiscountedMinor(baseAmountMinor, promotion),
    expectedDiscountSource: internalPass
      ? "internal_pass"
      : discountResolvable
        ? "stripe_promotion_code"
        : "none",
    discountsParamSent,
    // Mirrors the route's spread: a discount means `allow_promotion_codes` is
    // omitted entirely; every other path still says `false` explicitly, so the
    // Stripe-side code entry box is never reachable from a Tomverse checkout.
    allowPromotionCodesParam: discountsParamSent ? "omitted" : "false",
    bothDiscountParamsSent: false,
    paymentMethodRequired: !internalPass,
    automaticRenewal: !internalPass,
    sessionCreated: false,
  };
};

/* -------------------------------------------------------------------------- */
/* Recommendations and summary                                                 */
/* -------------------------------------------------------------------------- */

export type RecommendedAction = {
  id:
    | "verify_deployment_sha"
    | "run_linkage_dry_run"
    | "fix_promotion_policy"
    | "stripe_mode_mismatch"
    | "product_mismatch"
    | "conflicting_active_code_requires_operator_review"
    | "account_state_blocks_checkout"
    | "configure_stripe"
    | "no_action_required";
  severity: "blocker" | "warning" | "info";
};

export type PromotionDiagnosticsReport = {
  status: DiagnosticsStatus;
  localPolicy: LocalPolicySection;
  account: AccountSection;
  stripe: StripeSection;
  checkoutPreview: CheckoutRequestPreview;
  abuseSignals: {
    evaluated: false;
    reason: "admin_request_ip_is_not_the_customer_ip";
    storedRiskSignals: {
      total: number;
      sharedIp: number;
      sharedPaymentMethod: number;
    };
  };
  recommendedActions: RecommendedAction[];
  reasonSlugs: string[];
};

export const summarizeDiagnostics = (sections: {
  localPolicy: LocalPolicySection;
  account: AccountSection;
  stripe: StripeSection;
  checkoutPreview: CheckoutRequestPreview;
}): DiagnosticsStatus => {
  const statuses = [
    sections.localPolicy.status,
    sections.account.status,
    sections.stripe.status,
  ];
  if (statuses.includes("fail") || sections.checkoutPreview.bothDiscountParamsSent) {
    return "blocked";
  }
  if (statuses.includes("warn")) return "warning";
  if (statuses.every((status) => status === "not_checked")) return "not_checked";
  return "ready";
};

export const recommendActions = ({
  localPolicy,
  account,
  stripe,
  checkoutPreview,
}: {
  localPolicy: LocalPolicySection;
  account: AccountSection;
  stripe: StripeSection;
  checkoutPreview: CheckoutRequestPreview;
}): RecommendedAction[] => {
  const actions: RecommendedAction[] = [];
  if (localPolicy.status === "fail") {
    actions.push({ id: "fix_promotion_policy", severity: "blocker" });
  }
  if (account.status === "fail") {
    actions.push({ id: "account_state_blocks_checkout", severity: "blocker" });
  }
  if (
    stripe.status === "not_checked" &&
    stripe.checks.some((item) => item.reason === "stripe_not_configured")
  ) {
    actions.push({ id: "configure_stripe", severity: "warning" });
  }
  if (stripe.blockingReasons.some((item) => item.endsWith(":livemode"))) {
    actions.push({ id: "stripe_mode_mismatch", severity: "blocker" });
  }
  if (
    stripe.blockingReasons.some((item) => item.endsWith(":applies_to_products"))
  ) {
    actions.push({ id: "product_mismatch", severity: "blocker" });
  }
  if (
    stripe.checks.some(
      (item) =>
        item.status === "fail" &&
        (item.reason === "active_code_owned_by_another_object" ||
          item.reason === "multiple_adoptable_codes" ||
          item.reason === "stored_coupon_mismatch" ||
          item.reason === "stored_linkage_fatal_mismatch")
    )
  ) {
    actions.push({
      id: "conflicting_active_code_requires_operator_review",
      severity: "blocker",
    });
  }
  if (
    stripe.checks.some(
      (item) =>
        item.status === "warn" &&
        (item.reason === "stored_object_missing_in_stripe" ||
          item.reason === "stored_coupon_missing_in_stripe" ||
          item.reason === "no_stored_coupon" ||
          item.reason === "no_stored_promotion_code")
    ) ||
    stripe.driftReasons.length > 0
  ) {
    actions.push({ id: "run_linkage_dry_run", severity: "warning" });
  }
  if (checkoutPreview.bothDiscountParamsSent) {
    actions.push({ id: "verify_deployment_sha", severity: "blocker" });
  }
  if (actions.length === 0) {
    actions.push({ id: "no_action_required", severity: "info" });
  }
  return actions;
};

export const collectReasonSlugs = ({
  localPolicy,
  account,
  stripe,
}: {
  localPolicy: LocalPolicySection;
  account: AccountSection;
  stripe: StripeSection;
}) =>
  Array.from(
    new Set(
      [...localPolicy.checks, ...account.checks, ...stripe.checks]
        .filter((item) => item.status === "fail" || item.status === "warn")
        .map((item) => item.reason)
        .filter((reason): reason is string => Boolean(reason))
    )
  );
