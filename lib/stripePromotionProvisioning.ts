import "server-only";

import type Stripe from "stripe";
import type {
  BillingPlanId,
  BillingPromotionConfig,
} from "@/lib/billingConfig";
import { prisma } from "@/lib/prisma";
import { getStripe } from "@/lib/stripe";
import {
  canAdoptStripePromotionCode,
  canUseStripePromotionCode,
  couponMismatches,
  describeMismatches,
  errorCodeForMismatches,
  expectedCouponForPromotion,
  fatalMismatches,
  isMissingResourceStripeError,
  isRetryableStripeError,
  promotionCodeIdempotencyKey,
  promotionCodeMismatches,
  promotionCouponIdempotencyKey,
  promotionStripePolicyViolation,
  stripeErrorFacts,
  stripeKeyLiveMode,
  type Mismatch,
  type ProvisioningStage,
  type StripeCouponFacts,
  type StripePromotionCodeFacts,
  type StripePromotionErrorCode,
} from "@/lib/stripePromotionProvisioningCore";

/**
 * Reconciles a Tomverse promotion with the Stripe Coupon and Promotion Code it
 * is supposed to be backed by, and hands Checkout a discount it can charge.
 *
 * This used to be a fifteen-line helper inside the checkout route that read
 * "if the database has an id use it, otherwise create one". Every way that can
 * go wrong -- the id points at nothing, the id points at a test-mode object,
 * the objects exist but the database write that was meant to record them
 * failed, an operator changed the coupon in the dashboard -- came out of the
 * route as the same 500, and a Stripe API call sitting between two database
 * writes with no idempotency key can create a duplicate on every retry.
 *
 * Separated out so the decisions are testable without a network, and so a
 * failure names its stage.
 */

export class StripePromotionProvisioningError extends Error {
  constructor(
    public readonly code: StripePromotionErrorCode,
    public readonly stage: ProvisioningStage,
    /** Safe operator fields only: reason slugs, Stripe ids, no discount values. */
    public readonly details: Record<string, unknown> = {},
    public readonly retryable = false
  ) {
    super(code);
    this.name = "StripePromotionProvisioningError";
  }
}

type PromotionDb = Pick<typeof prisma, "billingPromotion">;

export type EnsureDiscountInput = {
  promotion: BillingPromotionConfig;
  planId: BillingPlanId;
  /** The plan's Stripe Product, used to check `applies_to` restrictions. */
  planProductId?: string | null;
  /** The customer this checkout is for, used to check customer restrictions. */
  customerId?: string | null;
  stripe?: Stripe;
  db?: PromotionDb;
  /** Overridable so tests can pin the mode without a real key. */
  expectLiveMode?: boolean | null;
  now?: Date;
};

export type EnsureDiscountResult = {
  discount: Stripe.Checkout.SessionCreateParams.Discount;
  promotionCodeId: string;
  couponId: string;
  /** How the object was obtained, for the structured log. */
  resolution: "linked" | "adopted" | "created";
  /** Non-fatal Stripe/database disagreements worth an operator's attention. */
  driftReasons: string[];
};

const couponFacts = (coupon: Stripe.Coupon): StripeCouponFacts => ({
  id: coupon.id,
  livemode: coupon.livemode,
  valid: coupon.valid,
  percentOff: coupon.percent_off ?? null,
  amountOff: coupon.amount_off ?? null,
  currency: coupon.currency ?? null,
  duration: coupon.duration ?? null,
  durationInMonths: coupon.duration_in_months ?? null,
  metadata: coupon.metadata ?? null,
  appliesToProducts: coupon.applies_to?.products ?? null,
});

/**
 * The coupon id, wherever this SDK version keeps it.
 *
 * Recent API versions moved it from `promotion_code.coupon` to
 * `promotion_code.promotion.coupon`. Reading only the old field yields
 * `undefined`, which would look like "no coupon linked" and send a perfectly
 * healthy promotion down the conflict path.
 */
const promotionCodeCouponId = (
  promotionCode: Stripe.PromotionCode
): string | null => {
  const record = promotionCode as unknown as Record<string, unknown>;
  const legacy = record.coupon;
  if (typeof legacy === "string") return legacy;
  if (legacy && typeof legacy === "object") {
    const id = (legacy as Record<string, unknown>).id;
    if (typeof id === "string") return id;
  }
  const promotion = record.promotion as Record<string, unknown> | undefined;
  const coupon = promotion?.coupon;
  if (typeof coupon === "string") return coupon;
  if (coupon && typeof coupon === "object") {
    const id = (coupon as Record<string, unknown>).id;
    if (typeof id === "string") return id;
  }
  return null;
};

const promotionCodeFacts = (
  promotionCode: Stripe.PromotionCode
): StripePromotionCodeFacts => ({
  id: promotionCode.id,
  code: promotionCode.code ?? null,
  active: promotionCode.active,
  livemode: promotionCode.livemode,
  couponId: promotionCodeCouponId(promotionCode),
  customerId:
    typeof promotionCode.customer === "string"
      ? promotionCode.customer
      : (promotionCode.customer?.id ?? null),
  maxRedemptions: promotionCode.max_redemptions ?? null,
  timesRedeemed: promotionCode.times_redeemed ?? null,
  expiresAtSeconds: promotionCode.expires_at ?? null,
  metadata: promotionCode.metadata ?? null,
});

const wrapStripeError = (
  error: unknown,
  stage: ProvisioningStage,
  fallback: StripePromotionErrorCode
): StripePromotionProvisioningError => {
  if (error instanceof StripePromotionProvisioningError) return error;
  const facts = stripeErrorFacts(error);
  const retryable = isRetryableStripeError(facts);
  return new StripePromotionProvisioningError(
    retryable ? "CHECKOUT_PROVIDER_UNAVAILABLE" : fallback,
    stage,
    {
      stripeErrorType: facts.type,
      stripeErrorCode: facts.code,
      stripeErrorParam: facts.param,
      stripeRequestId: facts.requestId,
    },
    retryable
  );
};

/**
 * Records the Stripe ids against the promotion without clobbering a concurrent
 * writer.
 *
 * Optimistic concurrency, expressed as a predicate on the row rather than a
 * read-then-write, so the check and the write cannot interleave. The linkage is
 * replaced only when the column still holds one of three things:
 *
 *   - null, meaning it was never provisioned;
 *   - the id that was read at the start of this attempt, including a *stale* id
 *     Stripe no longer knows -- repairing that is the whole point;
 *   - the id being written, so a retry is a no-op rather than a conflict.
 *
 * Anything else means an administrator or another request moved the linkage
 * while this attempt was in flight, and their value wins. The `code` clause
 * does the same for a promotion that was renamed mid-flight: a linkage
 * provisioned for the old code must not be stamped over the new one.
 */
async function linkStripeObjects({
  db,
  promotion,
  couponId,
  promotionCodeId,
}: {
  db: PromotionDb;
  promotion: BillingPromotionConfig;
  couponId: string;
  promotionCodeId: string;
}) {
  const acceptable = [
    { stripePromotionCodeId: null },
    { stripePromotionCodeId: promotionCodeId },
    ...(promotion.stripePromotionCodeId
      ? [{ stripePromotionCodeId: promotion.stripePromotionCodeId }]
      : []),
  ];
  const linked = await db.billingPromotion.updateMany({
    where: { id: promotion.id, code: promotion.code, OR: acceptable },
    data: { stripeCouponId: couponId, stripePromotionCodeId: promotionCodeId },
  });
  return linked.count > 0;
}

async function retrieveCoupon(
  stripe: Stripe,
  couponId: string
): Promise<Stripe.Coupon | null> {
  try {
    return await stripe.coupons.retrieve(couponId);
  } catch (error) {
    const facts = stripeErrorFacts(error);
    if (isMissingResourceStripeError(facts)) return null;
    throw wrapStripeError(error, "coupon", "PROMOTION_COUPON_INVALID");
  }
}

async function retrievePromotionCode(
  stripe: Stripe,
  promotionCodeId: string
): Promise<Stripe.PromotionCode | null> {
  try {
    return await stripe.promotionCodes.retrieve(promotionCodeId);
  } catch (error) {
    const facts = stripeErrorFacts(error);
    if (isMissingResourceStripeError(facts)) return null;
    throw wrapStripeError(error, "promotion_code", "PROMOTION_CODE_CONFLICT");
  }
}

/**
 * Verifies a promotion code and its coupon against the policy in one place, so
 * the linked path, the adoption path and the reconciliation script all judge an
 * object identically.
 */
async function evaluatePromotionCode({
  stripe,
  promotionCode,
  promotion,
  planId,
  planProductId,
  customerId,
  expectLiveMode,
  now,
}: {
  stripe: Stripe;
  promotionCode: Stripe.PromotionCode;
  promotion: BillingPromotionConfig;
  planId: BillingPlanId;
  planProductId?: string | null;
  customerId?: string | null;
  expectLiveMode: boolean | null;
  now: Date;
}): Promise<{
  mismatches: Mismatch[];
  couponId: string | null;
  couponMissing: boolean;
}> {
  const facts = promotionCodeFacts(promotionCode);
  const mismatches = promotionCodeMismatches({
    promotionCode: facts,
    promotion,
    planId,
    expectLiveMode,
    nowSeconds: Math.floor(now.getTime() / 1000),
    customerId,
  });

  if (!facts.couponId) {
    return {
      mismatches: [
        ...mismatches,
        { reason: "coupon_missing", severity: "identity" },
      ],
      couponId: null,
      couponMissing: true,
    };
  }

  const coupon = await retrieveCoupon(stripe, facts.couponId);
  if (!coupon) {
    return {
      mismatches: [
        ...mismatches,
        { reason: "coupon_missing", severity: "identity" },
      ],
      couponId: facts.couponId,
      couponMissing: true,
    };
  }

  return {
    mismatches: [
      ...mismatches,
      ...couponMismatches({
        coupon: couponFacts(coupon),
        promotion,
        planId,
        expectLiveMode,
        planProductId,
      }),
    ],
    couponId: coupon.id,
    couponMissing: false,
  };
}

/**
 * Exact-code search, used whenever the database has no id or its id points at
 * nothing.
 *
 * This is the recovery for the partial success that no transaction can prevent:
 * Stripe accepted the create and the database write that was meant to record it
 * did not land. Without it, the next attempt tries to create a code that
 * already exists, Stripe refuses it as a duplicate, and the promotion is stuck
 * until somebody edits the row by hand.
 */
async function findPromotionCodesByExactCode(
  stripe: Stripe,
  code: string
): Promise<Stripe.PromotionCode[]> {
  try {
    const result = await stripe.promotionCodes.list({ code, limit: 20 });
    // Stripe's `code` filter is case-insensitive; re-check rather than trust it,
    // so a substring or fuzzy match can never be adopted.
    return result.data.filter(
      (candidate) => (candidate.code || "").toUpperCase() === code.toUpperCase()
    );
  } catch (error) {
    throw wrapStripeError(
      error,
      "promotion_code",
      "PROMOTION_PROVISIONING_FAILED"
    );
  }
}

async function ensureCoupon({
  stripe,
  promotion,
  planId,
  planProductId,
  expectLiveMode,
}: {
  stripe: Stripe;
  promotion: BillingPromotionConfig;
  planId: BillingPlanId;
  planProductId?: string | null;
  expectLiveMode: boolean | null;
}): Promise<string> {
  if (promotion.stripeCouponId) {
    const existing = await retrieveCoupon(stripe, promotion.stripeCouponId);
    if (existing) {
      const mismatches = couponMismatches({
        coupon: couponFacts(existing),
        promotion,
        planId,
        expectLiveMode,
        planProductId,
      });
      if (canUseStripePromotionCode(mismatches)) return existing.id;
      throw new StripePromotionProvisioningError(
        errorCodeForMismatches(mismatches, "PROMOTION_COUPON_INVALID"),
        "coupon",
        {
          stripeCouponId: existing.id,
          mismatches: describeMismatches(fatalMismatches(mismatches)),
        }
      );
    }
    // A stored coupon id Stripe does not know is not fatal on its own: the
    // coupon is ours to re-create, and the idempotency key below makes that
    // safe. The promotion *code* is the object with a globally unique name and
    // is handled separately.
  }

  const expected = expectedCouponForPromotion(promotion, planId);
  try {
    const coupon = await stripe.coupons.create(
      {
        name: `${promotion.code} ${planId.toUpperCase()}`,
        duration: expected.duration,
        duration_in_months: expected.durationInMonths,
        percent_off: expected.percentOff ?? undefined,
        amount_off: expected.amountOff ?? undefined,
        currency: expected.currency ?? undefined,
        metadata: expected.metadata,
      },
      { idempotencyKey: promotionCouponIdempotencyKey(promotion, planId) }
    );
    return coupon.id;
  } catch (error) {
    throw wrapStripeError(error, "coupon", "PROMOTION_PROVISIONING_FAILED");
  }
}

export async function ensureStripePromotionDiscount({
  promotion,
  planId,
  planProductId = null,
  customerId = null,
  stripe = getStripe(),
  db = prisma,
  expectLiveMode = stripeKeyLiveMode(process.env.STRIPE_SECRET_KEY),
  now = new Date(),
}: EnsureDiscountInput): Promise<EnsureDiscountResult> {
  // Ahead of any network call: a promotion Stripe cannot represent is a
  // configuration mistake with a knowable answer, and reporting it as a
  // provider failure sends the operator looking in the wrong place.
  const policyViolation = promotionStripePolicyViolation(promotion);
  if (policyViolation) {
    throw new StripePromotionProvisioningError(
      "PROMOTION_COUPON_INVALID",
      "coupon",
      { policyViolation }
    );
  }

  const evaluate = (promotionCode: Stripe.PromotionCode) =>
    evaluatePromotionCode({
      stripe,
      promotionCode,
      promotion,
      planId,
      planProductId,
      customerId,
      expectLiveMode,
      now,
    });

  // 1. The linked object, if the database has one and Stripe still has it.
  if (promotion.stripePromotionCodeId) {
    const linked = await retrievePromotionCode(
      stripe,
      promotion.stripePromotionCodeId
    );
    if (linked) {
      const { mismatches, couponId } = await evaluate(linked);
      if (canUseStripePromotionCode(mismatches) && couponId) {
        return {
          discount: { promotion_code: linked.id },
          promotionCodeId: linked.id,
          couponId,
          resolution: "linked",
          driftReasons: describeMismatches(
            mismatches.filter((item) => item.severity === "drift")
          ),
        };
      }
      // A linked object that no longer matches is never repaired here, and never
      // deactivated or deleted: it may be attached to live subscriptions. It is
      // reported so an operator decides.
      throw new StripePromotionProvisioningError(
        errorCodeForMismatches(mismatches),
        "promotion_code",
        {
          stripePromotionCodeId: linked.id,
          mismatches: describeMismatches(fatalMismatches(mismatches)),
        }
      );
    }
    // Retrieved nothing. Either the id is stale, or it belongs to the other
    // mode. Fall through to exact-code reconciliation rather than creating
    // blind -- a create would collide with whatever is actually there.
  }

  // 2. Exact-code reconciliation.
  const candidates = await findPromotionCodesByExactCode(
    stripe,
    promotion.code
  );
  const adoptable: { promotionCode: Stripe.PromotionCode; couponId: string }[] =
    [];
  const rejected: { id: string; mismatches: Mismatch[] }[] = [];
  for (const candidate of candidates) {
    const { mismatches, couponId } = await evaluate(candidate);
    if (canAdoptStripePromotionCode(mismatches) && couponId) {
      adoptable.push({ promotionCode: candidate, couponId });
    } else {
      rejected.push({ id: candidate.id, mismatches });
    }
  }

  if (adoptable.length === 1) {
    const [{ promotionCode, couponId }] = adoptable;
    const linked = await linkStripeObjects({
      db,
      promotion,
      couponId,
      promotionCodeId: promotionCode.id,
    });
    if (!linked) {
      // Another writer got there first. Not an error -- but the linkage is now
      // somebody else's, so this attempt does not assume it matches.
      const current = await db.billingPromotion.findUnique({
        where: { id: promotion.id },
        select: { stripePromotionCodeId: true },
      });
      if (current?.stripePromotionCodeId !== promotionCode.id) {
        throw new StripePromotionProvisioningError(
          "PROMOTION_CODE_CONFLICT",
          "db_linkage",
          { reason: "concurrent_linkage" },
          true
        );
      }
    }
    return {
      discount: { promotion_code: promotionCode.id },
      promotionCodeId: promotionCode.id,
      couponId,
      resolution: "adopted",
      driftReasons: [],
    };
  }

  if (adoptable.length > 1) {
    // Impossible while Stripe enforces one active code per string, so if it
    // happens the assumption is wrong and guessing is not acceptable.
    throw new StripePromotionProvisioningError(
      "PROMOTION_CODE_CONFLICT",
      "promotion_code",
      {
        reason: "multiple_adoptable_codes",
        stripePromotionCodeIds: adoptable.map((item) => item.promotionCode.id),
      }
    );
  }

  // A code string that is taken by an object that is not ours cannot be
  // created and must not be adopted. Report the collision and stop; taking it
  // over would point a Tomverse promotion at a discount nobody here configured.
  const activeRejected = rejected.filter((item) => {
    const candidate = candidates.find((entry) => entry.id === item.id);
    return candidate?.active !== false;
  });
  if (activeRejected.length > 0) {
    const combined = activeRejected.flatMap((item) => item.mismatches);
    throw new StripePromotionProvisioningError(
      errorCodeForMismatches(combined),
      "promotion_code",
      {
        reason: "active_code_owned_by_another_object",
        stripePromotionCodeIds: activeRejected.map((item) => item.id),
        mismatches: describeMismatches(fatalMismatches(combined)),
      }
    );
  }

  // 3. Nothing usable exists. Create, with stable idempotency keys so a network
  // retry or a concurrent request returns the same objects instead of a
  // duplicate coupon and a code Stripe then refuses as taken.
  const couponId = await ensureCoupon({
    stripe,
    promotion,
    planId,
    planProductId,
    expectLiveMode,
  });

  let promotionCode: Stripe.PromotionCode;
  try {
    promotionCode = await stripe.promotionCodes.create(
      {
        // This SDK version nests the coupon under `promotion`; the flat
        // `coupon` parameter is the older shape and is not accepted here.
        promotion: { type: "coupon", coupon: couponId },
        code: promotion.code,
        active: true,
        max_redemptions: promotion.maxRedemptions ?? undefined,
        expires_at: promotion.endsAt
          ? Math.floor(new Date(promotion.endsAt).getTime() / 1000)
          : undefined,
        metadata: { tomversePromotionId: promotion.id, planId },
      },
      { idempotencyKey: promotionCodeIdempotencyKey(promotion, planId) }
    );
  } catch (error) {
    throw wrapStripeError(
      error,
      "promotion_code",
      "PROMOTION_PROVISIONING_FAILED"
    );
  }

  await linkStripeObjects({
    db,
    promotion,
    couponId,
    promotionCodeId: promotionCode.id,
  });

  return {
    discount: { promotion_code: promotionCode.id },
    promotionCodeId: promotionCode.id,
    couponId,
    resolution: "created",
    driftReasons: [],
  };
}

export type PromotionLinkageReport = {
  promotionId: string;
  code: string;
  policyViolation: string | null;
  expectLiveMode: boolean | null;
  storedCouponId: string | null;
  /**
   * Whether the stored coupon is still in Stripe, and how it compares.
   *
   * Absent from the first version of this report, which printed
   * `storedCouponId` and never checked it. That is not a cosmetic gap: when the
   * row points at a coupon somebody created by hand in the dashboard --
   * `duration: once` where the policy says `repeating`, no metadata --
   * `ensureCoupon()` retrieves it, fails it, and throws
   * `PROMOTION_COUPON_INVALID`, which reaches the customer as "This promotion
   * is not currently available." The report meanwhile said
   * `create_missing_objects`, i.e. "nothing here, the next checkout will
   * provision it", which is the opposite of what happens.
   */
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

/**
 * Read-only inspection used by `npm run billing:reconcile-promotion`.
 *
 * Runs exactly the checks `ensureStripePromotionDiscount` runs and mutates
 * nothing -- no create, no update, no deactivation. An operator has to be able
 * to see what the repair would be before anyone authorises it.
 */
export async function inspectStripePromotionLinkage({
  promotion,
  planId,
  planProductId = null,
  stripe = getStripe(),
  expectLiveMode = stripeKeyLiveMode(process.env.STRIPE_SECRET_KEY),
  now = new Date(),
}: {
  promotion: BillingPromotionConfig;
  planId: BillingPlanId;
  planProductId?: string | null;
  stripe?: Stripe;
  expectLiveMode?: boolean | null;
  now?: Date;
}): Promise<PromotionLinkageReport> {
  const policyViolation = promotionStripePolicyViolation(promotion);
  const report: PromotionLinkageReport = {
    promotionId: promotion.id,
    code: promotion.code,
    policyViolation,
    expectLiveMode,
    storedCouponId: promotion.stripeCouponId,
    storedCouponExists: false,
    storedCouponMismatches: [],
    storedPromotionCodeId: promotion.stripePromotionCodeId,
    storedPromotionCodeExists: false,
    storedPromotionCodeMismatches: [],
    exactCodeCandidates: [],
    recommendation: "manual_review",
  };

  // Checked first, and independently of the promotion code, because
  // `ensureCoupon()` reaches it first: a stored coupon that exists and no
  // longer matches the policy is a hard stop before the promotion code is even
  // considered, whatever the code-level state looks like.
  let storedCouponBlocks = false;
  if (promotion.stripeCouponId) {
    const storedCoupon = await retrieveCoupon(stripe, promotion.stripeCouponId);
    if (storedCoupon) {
      report.storedCouponExists = true;
      const mismatches = couponMismatches({
        coupon: couponFacts(storedCoupon),
        promotion,
        planId,
        expectLiveMode,
        planProductId,
      });
      report.storedCouponMismatches = describeMismatches(mismatches);
      storedCouponBlocks = !canUseStripePromotionCode(mismatches);
    }
    // A stored id Stripe does not know is not a blocker on its own: the coupon
    // is ours to re-create, and `ensureCoupon()` does exactly that under a
    // stable idempotency key.
  }

  const evaluate = (promotionCode: Stripe.PromotionCode) =>
    evaluatePromotionCode({
      stripe,
      promotionCode,
      promotion,
      planId,
      planProductId,
      customerId: null,
      expectLiveMode,
      now,
    });

  if (promotion.stripePromotionCodeId) {
    const linked = await retrievePromotionCode(
      stripe,
      promotion.stripePromotionCodeId
    );
    if (linked) {
      report.storedPromotionCodeExists = true;
      const { mismatches } = await evaluate(linked);
      report.storedPromotionCodeMismatches = describeMismatches(mismatches);
      if (canUseStripePromotionCode(mismatches) && !storedCouponBlocks) {
        report.recommendation = "healthy";
        return report;
      }
    }
  }

  const candidates = await findPromotionCodesByExactCode(
    stripe,
    promotion.code
  );
  for (const candidate of candidates) {
    const { mismatches } = await evaluate(candidate);
    report.exactCodeCandidates.push({
      id: candidate.id,
      active: candidate.active !== false,
      livemode: Boolean(candidate.livemode),
      mismatches: describeMismatches(mismatches),
      adoptable: canAdoptStripePromotionCode(mismatches),
    });
  }

  const adoptable = report.exactCodeCandidates.filter((item) => item.adoptable);
  if (policyViolation || storedCouponBlocks) {
    // `storedCouponBlocks` outranks every other recommendation, including
    // "create_missing_objects". Nothing a later step could do rescues a stored
    // coupon that `ensureCoupon()` will refuse, and the object may be attached
    // to live subscriptions, so it is never repaired or replaced here.
    report.recommendation = "manual_review";
  } else if (adoptable.length === 1) {
    report.recommendation =
      report.storedPromotionCodeId && !report.storedPromotionCodeExists
        ? "relink_stored_object"
        : "adopt_exact_match";
  } else if (
    report.exactCodeCandidates.length === 0 &&
    !report.storedPromotionCodeExists
  ) {
    report.recommendation = "create_missing_objects";
  }
  return report;
}
