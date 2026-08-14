import { createHash, createHmac } from "node:crypto";
export { stripeKeyLiveMode } from "@/lib/stripeMode";

/**
 * Pure decision layer for turning a Tomverse promotion into the Stripe Coupon
 * and Promotion Code that Checkout can charge against.
 *
 * Everything here is a function of plain data: no Stripe client, no Prisma, no
 * clock of its own. That is deliberate. The failures this module exists to
 * prevent -- adopting somebody else's promotion code, re-creating an object
 * that already exists, charging a discount that no longer matches the policy --
 * only ever showed up in production, where they cannot be reproduced. As pure
 * predicates they are ordinary unit tests.
 *
 * lib/stripePromotionProvisioning.ts owns the I/O and calls into this.
 */

/** Internal classification. Never returned to a customer verbatim. */
export const STRIPE_PROMOTION_ERROR_CODES = [
  "PROMOTION_STRIPE_OBJECT_MISSING",
  "PROMOTION_STRIPE_MODE_MISMATCH",
  "PROMOTION_CODE_CONFLICT",
  "PROMOTION_COUPON_INVALID",
  "PROMOTION_PRODUCT_MISMATCH",
  "PROMOTION_PROVISIONING_FAILED",
  "CHECKOUT_SESSION_CREATE_FAILED",
  "CHECKOUT_PROVIDER_UNAVAILABLE",
] as const;

export type StripePromotionErrorCode =
  (typeof STRIPE_PROMOTION_ERROR_CODES)[number];

/** Which Stripe call was in flight. Logged so an operator can resume there. */
export const PROVISIONING_STAGES = [
  "customer",
  "coupon",
  "promotion_code",
  "session",
  "db_linkage",
] as const;

export type ProvisioningStage = (typeof PROVISIONING_STAGES)[number];

export type PromotionPolicyInput = {
  id: string;
  code: string;
  discountPercent: number;
  discountAmountCents: number | null;
  durationMonths: number;
  maxRedemptions: number | null;
  endsAt: string | null;
  /**
   * Every plan this promotion is allowed on, from the policy row.
   *
   * Present because a Stripe promotion *code string* is globally unique among
   * active codes, and `BillingPromotion` carries one `stripePromotionCodeId`
   * for the whole row -- so a promotion eligible for both plans is served by
   * one Stripe object, whichever plan's checkout provisioned it. Judging that
   * object against the plan currently checking out would refuse the promotion
   * on every plan except the one that happened to create it. See
   * `planMetadataMismatch`.
   *
   * Optional so the shape stays constructible from a policy fragment; when it
   * is absent the only plan known to be eligible is the one being asked about,
   * and any other stamp is reported as drift.
   */
  appliesToPlanIds?: readonly string[];
};

/**
 * The Coupon this promotion is supposed to have, derived from the policy row.
 *
 * Both the create call and every match check read this one function, so a
 * created object and an adopted object are held to the same standard. Deriving
 * the expectation twice is how "we created it correctly" and "we accepted it
 * incorrectly" drift apart.
 */
export type ExpectedCoupon = {
  percentOff: number | null;
  amountOff: number | null;
  currency: string | null;
  duration: "repeating";
  durationInMonths: number;
  metadata: { tomversePromotionId: string; planId: string };
};

export const expectedCouponForPromotion = (
  promotion: PromotionPolicyInput,
  planId: string
): ExpectedCoupon => ({
  percentOff: promotion.discountPercent > 0 ? promotion.discountPercent : null,
  amountOff:
    promotion.discountPercent > 0
      ? null
      : promotion.discountAmountCents || null,
  currency: promotion.discountPercent > 0 ? null : "usd",
  duration: "repeating",
  durationInMonths: promotion.durationMonths,
  metadata: { tomversePromotionId: promotion.id, planId },
});

/**
 * Policy violations that make the promotion unrepresentable in Stripe at all,
 * checked before any network call.
 *
 * These used to surface as a 500 from deep inside the Stripe SDK. They are
 * configuration mistakes with a knowable answer, so they belong in front of the
 * API, classified, not behind it as an opaque provider failure.
 */
export const promotionStripePolicyViolation = (
  promotion: PromotionPolicyInput
): string | null => {
  if (!promotion.maxRedemptions || promotion.maxRedemptions <= 0) {
    return "max_redemptions_missing";
  }
  if (!promotion.endsAt) return "ends_at_missing";
  if (
    !Number.isSafeInteger(promotion.durationMonths) ||
    promotion.durationMonths <= 0
  ) {
    // Stripe rejects `duration: repeating` without a positive
    // `duration_in_months`, and a coupon whose discount lasts zero months is
    // not a promotion anyone meant to configure.
    return "duration_months_invalid";
  }
  if (
    promotion.discountPercent <= 0 &&
    !(promotion.discountAmountCents && promotion.discountAmountCents > 0)
  ) {
    return "discount_missing";
  }
  if (promotion.discountPercent < 0 || promotion.discountPercent > 100) {
    return "discount_percent_out_of_range";
  }
  return null;
};

/**
 * A short, stable fingerprint of the policy fields that determine the *shape*
 * of the Stripe objects.
 *
 * It is the reason an idempotency key can be stable without being permanent:
 * retrying the same promotion returns the same Coupon, but editing the discount
 * produces a different key, so Stripe is asked for a new object rather than
 * replaying the old one under a request body it no longer matches. Contains no
 * user identifier.
 */
export const promotionPolicyVersion = (
  promotion: PromotionPolicyInput,
  planId: string
) =>
  createHash("sha256")
    .update(
      JSON.stringify([
        promotion.code.toUpperCase(),
        promotion.discountPercent,
        promotion.discountAmountCents ?? null,
        promotion.durationMonths,
        promotion.maxRedemptions ?? null,
        promotion.endsAt ?? null,
        planId,
      ])
    )
    .digest("hex")
    .slice(0, 16);

export const promotionCouponIdempotencyKey = (
  promotion: PromotionPolicyInput,
  planId: string
) =>
  `tomverse:promotion-coupon:${promotion.id}:${planId}:${promotionPolicyVersion(
    promotion,
    planId
  )}`;

export const promotionCodeIdempotencyKey = (
  promotion: PromotionPolicyInput,
  planId: string
) =>
  `tomverse:promotion-code:${promotion.id}:${planId}:${promotionPolicyVersion(
    promotion,
    planId
  )}`;

/**
 * Idempotency key for one Checkout Session.
 *
 * Keyed on the client's purchase attempt, never on `(userId, promotionId)`
 * alone: Stripe replays a key for 24 hours, so a permanent key would keep
 * handing back a Session that expired 31 minutes in and leave the customer
 * clicking a dead link for the rest of the day. A network retry of the same
 * submission carries the same attempt id and is deduplicated; pressing the
 * button again is a new attempt and gets a new Session.
 *
 * The account is identified by an HMAC rather than its raw id so the key --
 * which Stripe stores and surfaces in dashboards and logs -- carries no
 * Tomverse identifier.
 */
export const checkoutSessionIdempotencyKey = ({
  userId,
  purchaseAttemptId,
  secret,
}: {
  userId: string;
  purchaseAttemptId: string;
  secret: string;
}) => {
  const subject = createHmac("sha256", secret)
    .update(`billing-checkout-subject:${userId}`)
    .digest("hex")
    .slice(0, 32);
  return `tomverse:checkout-session:${subject}:${purchaseAttemptId}`;
};

/**
 * Idempotency key for first-time Stripe Customer creation.
 *
 * Two checkout attempts that arrive before the first one has written
 * `stripeCustomerId` back both see a null column and both create a customer.
 * The second customer then owns the subscription the webhook cannot match to
 * an account. Keyed per account, permanently: unlike a Session, "the customer
 * for this account" is meant to be the same object forever.
 */
export const stripeCustomerIdempotencyKey = ({
  userId,
  secret,
}: {
  userId: string;
  secret: string;
}) =>
  `tomverse:billing-customer:${createHmac("sha256", secret)
    .update(`billing-customer-subject:${userId}`)
    .digest("hex")
    .slice(0, 32)}`;

export type StripeCouponFacts = {
  id: string;
  livemode?: boolean | null;
  valid?: boolean | null;
  percentOff?: number | null;
  amountOff?: number | null;
  currency?: string | null;
  duration?: string | null;
  durationInMonths?: number | null;
  metadata?: Record<string, string | undefined> | null;
  appliesToProducts?: string[] | null;
};

export type StripePromotionCodeFacts = {
  id: string;
  code?: string | null;
  active?: boolean | null;
  livemode?: boolean | null;
  couponId?: string | null;
  customerId?: string | null;
  maxRedemptions?: number | null;
  timesRedeemed?: number | null;
  expiresAtSeconds?: number | null;
  metadata?: Record<string, string | undefined> | null;
};

/**
 * Mismatch reasons are split into two severities because "is this object ours"
 * and "can this object still be charged" are different questions.
 *
 * `identity` reasons mean the object is not the one this promotion describes --
 * a different discount, a different plan, a different account's code. Charging
 * it would bill the customer something nobody approved, so it is always fatal.
 *
 * `usability` reasons mean the object is ours but cannot serve this checkout
 * right now (inactive, expired, spent, reserved for another customer).
 *
 * `drift` reasons mean Stripe and the database disagree about a limit without
 * that disagreement biting yet -- an operator raised `maxRedemptions` in the
 * admin console and the Stripe cap stayed where it was. Reported, never fatal:
 * turning a caps mismatch into a customer-facing failure would take promotion
 * checkout down for a discrepancy that has not denied anyone anything.
 */
export type MismatchSeverity = "identity" | "usability" | "drift";

export type Mismatch = { reason: string; severity: MismatchSeverity };

const identity = (reason: string): Mismatch => ({
  reason,
  severity: "identity",
});
const usability = (reason: string): Mismatch => ({
  reason,
  severity: "usability",
});
const drift = (reason: string): Mismatch => ({ reason, severity: "drift" });

/**
 * Judges the `planId` stamped into a Stripe object's metadata.
 *
 * This used to be `metadata.planId !== planId -> identity`, and that is the
 * defect behind "This promotion is not currently available." on a promotion
 * whose own validation had just succeeded. Three facts make the strict form
 * unsatisfiable:
 *
 *   - `appliesToPlanIds` accepts both plans (the admin schema allows a
 *     two-element array), so one promotion row can be sold on Pro *and* Max;
 *   - `BillingPromotion` has exactly one `stripeCouponId` /
 *     `stripePromotionCodeId` pair for that row, not one per plan; and
 *   - Stripe enforces one *active* promotion code per code string, so a second
 *     object stamped with the other plan cannot be created even if there were
 *     somewhere to store it.
 *
 * So the object is necessarily stamped with whichever plan checked out first,
 * and the other plan was permanently refused: identity mismatch -> fatal ->
 * `PROMOTION_CODE_CONFLICT` -> `PROMOTION_UNAVAILABLE`. Validation never saw it
 * because validation never reads Stripe.
 *
 * What the stamp can still prove is unchanged. Ownership is asserted by
 * `metadata.tomversePromotionId`, which is checked separately and stays fatal;
 * an object carrying *no* stamp is still not one this system created. And
 * nothing here decides which plan a discount may be charged against -- that is
 * `promotionEligibilityFailure()` on `appliesToPlanIds` before any Stripe call,
 * and the coupon's own `applies_to.products` against the plan's product below,
 * both of which remain fatal.
 *
 * A stamp naming a plan the promotion no longer covers is reported as drift
 * rather than identity: the row was edited after the object was provisioned,
 * ownership is not in doubt, and turning an operator's policy edit into a
 * customer-facing checkout failure is the behaviour this function exists to
 * remove. Drift still blocks *adoption* of an unlinked object, which is the
 * asymmetry `canAdoptStripePromotionCode` is built on.
 */
export const planMetadataMismatch = (
  stampedPlanId: string | undefined | null,
  planId: string,
  eligiblePlanIds: readonly string[] | undefined
): Mismatch | null => {
  if (!stampedPlanId) return identity("metadata_plan_id");
  if (stampedPlanId === planId) return null;
  const eligible = eligiblePlanIds?.length ? eligiblePlanIds : [planId];
  if (eligible.includes(stampedPlanId)) return null;
  return drift("metadata_plan_id_stale");
};

export const couponMismatches = ({
  coupon,
  promotion,
  planId,
  expectLiveMode,
  planProductId,
}: {
  coupon: StripeCouponFacts;
  promotion: PromotionPolicyInput;
  planId: string;
  expectLiveMode: boolean | null;
  planProductId?: string | null;
}): Mismatch[] => {
  const expected = expectedCouponForPromotion(promotion, planId);
  const mismatches: Mismatch[] = [];

  if (expectLiveMode !== null && typeof coupon.livemode === "boolean") {
    if (coupon.livemode !== expectLiveMode)
      mismatches.push(identity("livemode"));
  }
  if (coupon.metadata?.tomversePromotionId !== promotion.id) {
    mismatches.push(identity("metadata_promotion_id"));
  }
  const couponPlanMismatch = planMetadataMismatch(
    coupon.metadata?.planId,
    planId,
    promotion.appliesToPlanIds
  );
  if (couponPlanMismatch) mismatches.push(couponPlanMismatch);
  if ((coupon.percentOff ?? null) !== expected.percentOff) {
    mismatches.push(identity("percent_off"));
  }
  if ((coupon.amountOff ?? null) !== expected.amountOff) {
    mismatches.push(identity("amount_off"));
  }
  if (expected.amountOff !== null) {
    const currency = coupon.currency ? coupon.currency.toLowerCase() : null;
    if (currency !== expected.currency) mismatches.push(identity("currency"));
  }
  if (coupon.duration !== expected.duration) {
    mismatches.push(identity("duration"));
  }
  if ((coupon.durationInMonths ?? null) !== expected.durationInMonths) {
    mismatches.push(identity("duration_in_months"));
  }
  // An `applies_to` restriction that excludes the plan's product silently
  // produces a Checkout Session that charges full price, which is worse than
  // failing: the customer is billed an amount the promotion said they would
  // not pay.
  const products = coupon.appliesToProducts;
  if (products && products.length > 0) {
    if (!planProductId || !products.includes(planProductId)) {
      mismatches.push(identity("applies_to_products"));
    }
  }
  if (coupon.valid === false) mismatches.push(usability("coupon_invalid"));

  return mismatches;
};

export const promotionCodeMismatches = ({
  promotionCode,
  promotion,
  planId,
  expectLiveMode,
  expectedCouponId,
  nowSeconds,
  customerId,
}: {
  promotionCode: StripePromotionCodeFacts;
  promotion: PromotionPolicyInput;
  planId: string;
  expectLiveMode: boolean | null;
  expectedCouponId?: string | null;
  nowSeconds: number;
  customerId?: string | null;
}): Mismatch[] => {
  const mismatches: Mismatch[] = [];

  if (expectLiveMode !== null && typeof promotionCode.livemode === "boolean") {
    if (promotionCode.livemode !== expectLiveMode) {
      mismatches.push(identity("livemode"));
    }
  }
  // Stripe treats promotion code strings as case-insensitive for uniqueness, so
  // the comparison has to be too -- otherwise a code stored lowercase looks
  // like a stranger's object and gets refused.
  if (
    (promotionCode.code || "").toUpperCase() !== promotion.code.toUpperCase()
  ) {
    mismatches.push(identity("code"));
  }
  if (promotionCode.metadata?.tomversePromotionId !== promotion.id) {
    mismatches.push(identity("metadata_promotion_id"));
  }
  const codePlanMismatch = planMetadataMismatch(
    promotionCode.metadata?.planId,
    planId,
    promotion.appliesToPlanIds
  );
  if (codePlanMismatch) mismatches.push(codePlanMismatch);
  if (expectedCouponId && promotionCode.couponId !== expectedCouponId) {
    mismatches.push(identity("coupon_id"));
  }
  if (promotionCode.active === false) mismatches.push(usability("inactive"));
  if (
    typeof promotionCode.expiresAtSeconds === "number" &&
    promotionCode.expiresAtSeconds <= nowSeconds
  ) {
    mismatches.push(usability("expired"));
  }
  if (
    typeof promotionCode.maxRedemptions === "number" &&
    typeof promotionCode.timesRedeemed === "number" &&
    promotionCode.timesRedeemed >= promotionCode.maxRedemptions
  ) {
    mismatches.push(usability("exhausted"));
  }
  // A code Stripe has reserved for one customer cannot serve another, and
  // handing it to the wrong account would be refused at the Session anyway.
  if (
    promotionCode.customerId &&
    (!customerId || promotionCode.customerId !== customerId)
  ) {
    mismatches.push(usability("customer_restricted"));
  }
  if (
    typeof promotionCode.maxRedemptions === "number" &&
    promotion.maxRedemptions !== null &&
    promotionCode.maxRedemptions !== promotion.maxRedemptions
  ) {
    mismatches.push(drift("max_redemptions"));
  }
  if (promotion.endsAt && typeof promotionCode.expiresAtSeconds === "number") {
    const expected = Math.floor(new Date(promotion.endsAt).getTime() / 1000);
    if (promotionCode.expiresAtSeconds !== expected) {
      mismatches.push(drift("expires_at"));
    }
  }

  return mismatches;
};

/**
 * Whether an object found by exact-code search may be adopted into the database.
 *
 * Strictly stricter than the check applied to an object we are already linked
 * to, and that asymmetry is the point. A linked object only has to still work;
 * an unknown one has to prove it is ours before we write its id down, so even
 * a drift-level disagreement blocks adoption. Adopting a stranger's code would
 * point a Tomverse promotion at a discount nobody here configured.
 */
export const canAdoptStripePromotionCode = (mismatches: Mismatch[]) =>
  mismatches.length === 0;

/** Whether an already-linked object can serve this checkout. */
export const canUseStripePromotionCode = (mismatches: Mismatch[]) =>
  mismatches.every((mismatch) => mismatch.severity === "drift");

export const fatalMismatches = (mismatches: Mismatch[]) =>
  mismatches.filter((mismatch) => mismatch.severity !== "drift");

/** Reason strings only. Never carries a Stripe object id or a discount value. */
export const describeMismatches = (mismatches: Mismatch[]) =>
  mismatches.map((mismatch) => `${mismatch.severity}:${mismatch.reason}`);

/**
 * Picks the internal error code for a set of fatal mismatches, most specific
 * first, so the operator sees the reason that explains the rest.
 */
export const errorCodeForMismatches = (
  mismatches: Mismatch[],
  fallback: StripePromotionErrorCode = "PROMOTION_CODE_CONFLICT"
): StripePromotionErrorCode => {
  const reasons = new Set(
    fatalMismatches(mismatches).map((item) => item.reason)
  );
  if (reasons.has("livemode")) return "PROMOTION_STRIPE_MODE_MISMATCH";
  if (reasons.has("applies_to_products")) return "PROMOTION_PRODUCT_MISMATCH";
  if (
    reasons.has("coupon_invalid") ||
    reasons.has("percent_off") ||
    reasons.has("amount_off") ||
    reasons.has("currency") ||
    reasons.has("duration") ||
    reasons.has("duration_in_months")
  ) {
    return "PROMOTION_COUPON_INVALID";
  }
  return fallback;
};

export type StripeErrorFacts = {
  type: string | null;
  code: string | null;
  param: string | null;
  requestId: string | null;
  statusCode: number | null;
};

/**
 * Pulls the operator-useful, customer-safe fields off a thrown Stripe error.
 *
 * Deliberately not the message: Stripe messages can quote request parameters,
 * which is how an internal object id ends up in a log line somebody pastes into
 * a ticket. Type, code, param and request id are enough to find the request in
 * the Stripe dashboard.
 */
export const stripeErrorFacts = (error: unknown): StripeErrorFacts => {
  const source = (error || {}) as Record<string, unknown>;
  const asString = (value: unknown) =>
    typeof value === "string" && value.trim() ? value.trim() : null;
  const raw = (source.raw || {}) as Record<string, unknown>;
  return {
    type: asString(source.type) || asString(raw.type),
    code: asString(source.code) || asString(raw.code),
    param: asString(source.param) || asString(raw.param),
    requestId: asString(source.requestId) || asString(source.request_id),
    statusCode:
      typeof source.statusCode === "number"
        ? source.statusCode
        : typeof source.status === "number"
          ? source.status
          : null,
  };
};

/** A Stripe error worth retrying, as opposed to one that will fail identically. */
export const isRetryableStripeError = (facts: StripeErrorFacts) => {
  if (
    facts.type === "StripeConnectionError" ||
    facts.type === "StripeAPIError" ||
    facts.type === "StripeRateLimitError" ||
    facts.type === "api_error" ||
    facts.type === "rate_limit_error"
  ) {
    return true;
  }
  return facts.statusCode === 429 || (facts.statusCode || 0) >= 500;
};

export const isMissingResourceStripeError = (facts: StripeErrorFacts) =>
  facts.code === "resource_missing" || facts.statusCode === 404;

export type ExternalCheckoutError = {
  status: number;
  code: string;
  error: string;
};

/**
 * Maps an internal classification onto what the customer is told.
 *
 * Two rules hold across every branch. A promotion whose configuration is wrong
 * is a 4xx, not a 500 -- retrying cannot fix it, and reporting it as a server
 * fault sends the customer to support with nothing to say. And no branch ever
 * carries a Stripe object id, a Stripe message, or a request id outward; those
 * live in the structured log, reachable from the `traceId` the response does
 * carry.
 */
export const externalCheckoutError = (
  code: StripePromotionErrorCode
): ExternalCheckoutError => {
  switch (code) {
    case "PROMOTION_CODE_CONFLICT":
    case "PROMOTION_COUPON_INVALID":
    case "PROMOTION_PRODUCT_MISMATCH":
    case "PROMOTION_STRIPE_MODE_MISMATCH":
      return {
        status: 400,
        code: "PROMOTION_UNAVAILABLE",
        error: "This promotion is not currently available.",
      };
    case "PROMOTION_STRIPE_OBJECT_MISSING":
    case "PROMOTION_PROVISIONING_FAILED":
    case "CHECKOUT_PROVIDER_UNAVAILABLE":
      return {
        status: 503,
        code: "CHECKOUT_TEMPORARILY_UNAVAILABLE",
        error: "Checkout is temporarily unavailable. Please try again shortly.",
      };
    case "CHECKOUT_SESSION_CREATE_FAILED":
    default:
      return {
        status: 500,
        code: "CHECKOUT_CONFIGURATION_ERROR",
        error: "Failed to start checkout.",
      };
  }
};
