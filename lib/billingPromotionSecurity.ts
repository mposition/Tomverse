import "server-only";

import { createHmac } from "node:crypto";
import { Prisma } from "@prisma/client";
import type Stripe from "stripe";
import { ApiSecurityError } from "@/lib/apiSecurity";
import {
  getBillingPromotionByCode,
  type BillingPlanId,
  type BillingPromotionConfig,
} from "@/lib/billingConfig";
import {
  promotionCountryFailure,
  promotionCurrencyFailure,
  promotionEligibilityFailure,
  type PromotionValidationReason,
} from "@/lib/billingPromotionCore";
import type { BillingCurrency } from "@/lib/billingMarkets";
import { getAnonymousClientKey } from "@/lib/clientIp";
import { getTrustedIpCountry } from "@/lib/trustedIpCountry";
import { prisma } from "@/lib/prisma";
import { promotionStripePolicyViolation } from "@/lib/stripePromotionProvisioningCore";

export type BillingInterval = "monthly" | "annual";
export type PromotionRiskFlag =
  | "shared_ip"
  | "shared_payment_method"
  /**
   * The card had already redeemed this promotion on as many other accounts as
   * `BillingPromotion.maxRedemptionsPerPaymentMethod` allows, so the checkout
   * webhook cancelled this subscription instead of granting the plan.
   */
  | "payment_method_limit"
  /**
   * No payment method on the subscription or the customer could be
   * identified, so the per-card limit could not be counted. A zero-charge
   * checkout is refused (with `payment_method_limit`) rather than let through
   * uncounted.
   */
  | "payment_method_unverified"
  /**
   * A paid checkout whose card was already at the per-card limit. Granted --
   * a paid checkout is never cancelled with the payment kept (owner decision,
   * 2026-11-21) -- but marked, so it can be told apart from ordinary sharing
   * under the limit (`shared_payment_method`).
   */
  | "paid_over_card_limit";

const PROMOTION_RISK_FLAGS: readonly PromotionRiskFlag[] = [
  "shared_ip",
  "shared_payment_method",
  "payment_method_limit",
  "payment_method_unverified",
  "paid_over_card_limit",
];

const PROMOTION_IP_WINDOW_MS = 30 * 86_400_000;
const PROMOTION_IP_DISTINCT_ACCOUNT_THRESHOLD = 3;
export const PROMOTION_CHECKOUT_TTL_SECONDS = 31 * 60;

const securitySecret = () => {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) {
    throw new ApiSecurityError(
      503,
      "SECURITY_NOT_CONFIGURED",
      "Promotion security is not configured."
    );
  }
  return secret;
};

const hashPromotionValue = (scope: string, value: string) =>
  createHmac("sha256", securitySecret())
    .update(`billing-promotion:${scope}:${value}`)
    .digest("hex");

export const getPromotionClientIpHash = (request: Request) =>
  hashPromotionValue("ip", getAnonymousClientKey(request));

export const hashPaymentMethodFingerprint = (fingerprint: string) =>
  hashPromotionValue("payment-method", fingerprint);

export const paymentMethodFingerprint = (
  paymentMethod: Stripe.PaymentMethod | null
) => {
  if (!paymentMethod) return null;
  const record = paymentMethod as unknown as Record<string, unknown>;
  const details = record[paymentMethod.type];
  if (!details || typeof details !== "object") return null;
  const fingerprint = (details as Record<string, unknown>).fingerprint;
  if (typeof fingerprint === "string" && fingerprint.trim()) {
    return fingerprint.trim();
  }
  // Stripe Link carries no card fingerprint; the Link account's email is
  // what identifies the payer across accounts. Prefixed so it can never equal
  // a card fingerprint.
  if (paymentMethod.type === "link") {
    const email = (details as Record<string, unknown>).email;
    return typeof email === "string" && email.trim()
      ? `link:${email.trim().toLowerCase()}`
      : null;
  }
  return null;
};

export const encodePromotionRiskFlags = (
  flags: Iterable<PromotionRiskFlag>
) => JSON.stringify(Array.from(new Set(flags)).sort());

export const parsePromotionRiskFlags = (
  value: string | null | undefined
): PromotionRiskFlag[] => {
  try {
    const parsed = JSON.parse(value || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is PromotionRiskFlag =>
      PROMOTION_RISK_FLAGS.includes(item)
    );
  } catch {
    return [];
  }
};

const promotionLeaseId = (promotionId: string, userId: string) =>
  `promo-${hashPromotionValue("checkout", `${promotionId}:${userId}`)}`;

export async function reservePromotionCheckout(
  promotionId: string,
  userId: string,
  now = new Date()
) {
  const id = promotionLeaseId(promotionId, userId);
  const expiresAt = new Date(
    now.getTime() + PROMOTION_CHECKOUT_TTL_SECONDS * 1000
  );
  try {
    await prisma.$transaction(async (tx) => {
      await tx.chatRequestLease.deleteMany({
        where: { id, expiresAt: { lte: now } },
      });
      await tx.chatRequestLease.create({
        data: {
          id,
          subjectKey: hashPromotionValue(
            "checkout-subject",
            `${promotionId}:${userId}`
          ),
          expiresAt,
        },
      });
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      throw new ApiSecurityError(
        409,
        "PROMOTION_CHECKOUT_IN_PROGRESS",
        "A checkout using this promotion is already in progress."
      );
    }
    throw error;
  }
  return { id, expiresAt };
}

/** The value a lease carries once its Checkout Session exists. */
const checkoutSessionLeaseTag = (checkoutSessionId: string) =>
  `stripe-session:${checkoutSessionId}`;

/**
 * Records which Checkout Session a promotion lease belongs to, right after the
 * Session is created, so a webhook about that Session releases exactly that
 * lease. Only an unbound lease is stamped: one already bound to another
 * Session is not taken over.
 */
export async function bindPromotionCheckoutLease(
  promotionId: string,
  userId: string,
  checkoutSessionId: string
) {
  await prisma.chatRequestLease.updateMany({
    where: { id: promotionLeaseId(promotionId, userId), admissionId: null },
    data: { admissionId: checkoutSessionLeaseTag(checkoutSessionId) },
  });
}

export async function releasePromotionCheckout(
  promotionId: string,
  userId: string,
  options: {
    /**
     * Release only the lease bound to this Checkout Session
     * (`bindPromotionCheckoutLease`), or -- for a lease that was never bound:
     * taken before this change, or its bind failed -- one taken no later than
     * `takenAtOrBefore`. A lease bound to a different Session is never
     * released by this one's webhook, however the clocks compare.
     */
    checkoutSessionId?: string;
    /**
     * Release only a lease taken no later than this instant.
     *
     * The lease id is `(promotionId, userId)` and records nothing about which
     * checkout attempt took it, so a webhook that arrives late would release a
     * lease belonging to a *later* attempt and let a second live Session exist
     * beside it -- the one thing this lease prevents. Stripe redelivers a
     * failed webhook for days, so "late" is not hypothetical.
     *
     * The lease is taken immediately before the Session is created, so it can
     * only belong to that attempt if it existed before the Session did. Callers
     * acting on a specific Session pass that Session's creation time; callers
     * releasing their own in-flight attempt pass nothing.
     */
    takenAtOrBefore?: Date;
  } = {}
) {
  const id = promotionLeaseId(promotionId, userId);
  if (options.checkoutSessionId) {
    await prisma.chatRequestLease.deleteMany({
      where: {
        id,
        // An unbound lease is only released with a time bound: without
        // one it could be a newer attempt's lease whose bind failed.
        OR: [
          { admissionId: checkoutSessionLeaseTag(options.checkoutSessionId) },
          ...(options.takenAtOrBefore
            ? [{ admissionId: null, createdAt: { lte: options.takenAtOrBefore } }]
            : []),
        ],
      },
    });
    return;
  }
  await prisma.chatRequestLease.deleteMany({
    where: {
      id,
      ...(options.takenAtOrBefore
        ? { createdAt: { lte: options.takenAtOrBefore } }
        : {}),
    },
  });
}

async function getPromotionIpRiskFlags({
  promotionId,
  userId,
  clientIpHash,
  now,
}: {
  promotionId: string;
  userId: string | null;
  clientIpHash: string;
  now: Date;
}) {
  const priorAccounts = await prisma.billingPromotionRedemption.findMany({
    where: {
      promotionId,
      clientIpHash,
      redeemedAt: {
        gte: new Date(now.getTime() - PROMOTION_IP_WINDOW_MS),
      },
      ...(userId ? { userId: { not: userId } } : {}),
    },
    select: { userId: true },
    distinct: ["userId"],
    take: PROMOTION_IP_DISTINCT_ACCOUNT_THRESHOLD - 1,
  });
  return priorAccounts.length >= PROMOTION_IP_DISTINCT_ACCOUNT_THRESHOLD - 1
    ? (["shared_ip"] satisfies PromotionRiskFlag[])
    : [];
}

export type PromotionValidationResult =
  | {
      valid: true;
      promotion: BillingPromotionConfig;
      clientIpHash: string;
      riskFlags: PromotionRiskFlag[];
    }
  | { valid: false; reason: PromotionValidationReason };

export async function validatePromotionForCheckout({
  code,
  planId,
  billingInterval,
  currency,
  userId,
  request,
  now = new Date(),
}: {
  code: string;
  planId: BillingPlanId;
  billingInterval: BillingInterval;
  /**
   * The currency this checkout will actually be charged in, decided by the
   * trusted market -- never a currency the client asked for.
   *
   * Required so both callers have to answer it. It was absent, and the currency
   * rule lived inside the checkout route instead, so validation returned
   * `valid: true` for a fixed-amount code in an AUD market and the order summary
   * quoted a discount the button then refused.
   */
  currency: BillingCurrency;
  userId: string | null;
  request: Request;
  now?: Date;
}): Promise<PromotionValidationResult> {
  const promotion = await getBillingPromotionByCode(code);
  if (!promotion) return { valid: false, reason: "invalid" };
  const eligibilityFailure = promotionEligibilityFailure({
    promotion,
    planId,
    billingInterval,
    now,
  });
  if (eligibilityFailure) return { valid: false, reason: eligibilityFailure };

  // A promotion Stripe cannot represent at all -- no redemption cap, no expiry,
  // a zero-month duration, a discount of nothing. `ensureStripePromotionDiscount`
  // refuses these before any network call, so a checkout carrying one fails
  // with PROMOTION_UNAVAILABLE after the order summary has already shown the
  // customer a discount. The check is pure, both endpoints run this function,
  // and running it here is what makes validation and Checkout agree on
  // everything decidable without reading Stripe.
  //
  // Skipped for an internal pass, which is fulfilled by granting an access
  // period and never reaches Stripe at all.
  if (promotion.fulfillmentType !== "internal_pass") {
    if (promotionStripePolicyViolation(promotion)) {
      return { valid: false, reason: "unavailable" };
    }
  }

  // Decided here, before any redemption lookup or IP hashing, because it is a
  // property of the promotion and the market and needs nothing else. Both
  // endpoints reach it, which is the whole point: the answer the order summary
  // is drawn from is the answer Checkout will give.
  const currencyFailure = promotionCurrencyFailure({ promotion, currency });
  if (currencyFailure) return { valid: false, reason: currencyFailure };

  // Also decided before any redemption lookup, and by the same function on
  // both endpoints, so the order summary and Checkout give the same answer.
  const countryFailure = promotionCountryFailure({
    allowedCountries: promotion.allowedCountries,
    country: getTrustedIpCountry(request.headers),
  });
  if (countryFailure) return { valid: false, reason: countryFailure };

  if (userId) {
    const existingRedemption =
      await prisma.billingPromotionRedemption.findUnique({
        where: {
          promotionId_userId: { promotionId: promotion.id, userId },
        },
        select: { id: true },
      });
    if (existingRedemption) {
      return { valid: false, reason: "already_used" };
    }
  }

  const clientIpHash = getPromotionClientIpHash(request);
  const riskFlags = await getPromotionIpRiskFlags({
    promotionId: promotion.id,
    userId,
    clientIpHash,
    now,
  });
  return { valid: true, promotion, clientIpHash, riskFlags };
}
