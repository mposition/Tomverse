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
  promotionEligibilityFailure,
  type PromotionValidationReason,
} from "@/lib/billingPromotionCore";
import { getAnonymousClientKey } from "@/lib/clientIp";
import { prisma } from "@/lib/prisma";
import { promotionStripePolicyViolation } from "@/lib/stripePromotionProvisioningCore";

export type BillingInterval = "monthly" | "annual";
export type PromotionRiskFlag = "shared_ip" | "shared_payment_method";

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
  return typeof fingerprint === "string" && fingerprint.trim()
    ? fingerprint.trim()
    : null;
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
    return parsed.filter(
      (item): item is PromotionRiskFlag =>
        item === "shared_ip" || item === "shared_payment_method"
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

export async function releasePromotionCheckout(
  promotionId: string,
  userId: string,
  options: {
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
  await prisma.chatRequestLease.deleteMany({
    where: {
      id: promotionLeaseId(promotionId, userId),
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
  userId,
  request,
  now = new Date(),
}: {
  code: string;
  planId: BillingPlanId;
  billingInterval: BillingInterval;
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
