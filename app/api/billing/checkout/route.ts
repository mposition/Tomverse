export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { randomUUID } from "node:crypto";
import type Stripe from "stripe";
import { z } from "zod";
import { authOptions } from "@/lib/auth";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
  readLimitedJson,
} from "@/lib/apiSecurity";
import {
  getBillingPlans,
  tierForPlanId,
  type BillingPlanId,
  type BillingPromotionConfig,
} from "@/lib/billingConfig";
import {
  encodePromotionRiskFlags,
  PROMOTION_CHECKOUT_TTL_SECONDS,
  releasePromotionCheckout,
  reservePromotionCheckout,
  validatePromotionForCheckout,
  type PromotionRiskFlag,
} from "@/lib/billingPromotionSecurity";
import { promotionValidationError } from "@/lib/billingPromotionCore";
import { sendBillingWelcomeEmail } from "@/lib/billingEmails";
import { prisma } from "@/lib/prisma";
import { getPublicAppOrigin } from "@/lib/publicUrl";
import { getStripe } from "@/lib/stripe";
import {
  analyticsAttributionSchema,
  purchaseAnalyticsTriggerSchema,
} from "@/lib/productAnalyticsShared";
import {
  analyticsCountryFromHeaders,
  recordProductAnalyticsEvent,
} from "@/lib/productAnalyticsServer";
import {
  getPurchaseAnalyticsSnapshot,
  purchaseAnalyticsMetadata,
} from "@/lib/purchaseAnalytics";

const checkoutSchema = z
  .object({
    planId: z.enum(["pro", "max"]),
    billingInterval: z.enum(["monthly", "annual"]).default("monthly"),
    language: z.enum(["ko", "en", "zh", "fr", "de", "es", "pt"]).optional(),
    promoCode: z.string().trim().toUpperCase().max(32).optional(),
    analytics: analyticsAttributionSchema.optional(),
    trigger: purchaseAnalyticsTriggerSchema.default("proactive"),
  })
  .strict();

const activeSubscriptionStatuses = new Set(["active", "trialing", "past_due"]);

type CheckoutPromotion = BillingPromotionConfig;
type CheckoutPlan = Awaited<ReturnType<typeof getBillingPlans>>[number];

const calculateDiscountedCents = (
  cents: number,
  promotion: CheckoutPromotion | null
) => {
  if (!promotion) return cents;
  if (promotion.discountPercent > 0) {
    return Math.max(0, Math.round(cents * (1 - promotion.discountPercent / 100)));
  }
  return Math.max(0, cents - (promotion.discountAmountCents || 0));
};

const priceCentsForInterval = (
  plan: CheckoutPlan,
  billingInterval: "monthly" | "annual"
) =>
  billingInterval === "annual" ? plan.annualPriceCents : plan.monthlyPriceCents;

const addBillingPeriod = (
  date: Date,
  billingInterval: "monthly" | "annual"
) => {
  const next = new Date(date);
  if (billingInterval === "annual") {
    next.setUTCFullYear(next.getUTCFullYear() + 1);
  } else {
    next.setUTCMonth(next.getUTCMonth() + 1);
  }
  return next;
};

const billingSuccessUrl = (
  origin: string,
  planId: BillingPlanId,
  billingInterval: "monthly" | "annual",
  language?: "ko" | "en" | "zh" | "fr" | "de" | "es" | "pt"
) =>
  `${origin}/chat?billing=success&plan=${encodeURIComponent(
    planId
  )}&interval=${encodeURIComponent(billingInterval)}${
    language ? `&lang=${encodeURIComponent(language)}` : ""
  }`;

async function activateZeroDollarPlan({
  userId,
  planId,
  billingInterval,
  promotion,
  clientIpHash,
  riskFlags,
}: {
  userId: string;
  planId: BillingPlanId;
  billingInterval: "monthly" | "annual";
  promotion: CheckoutPromotion | null;
  clientIpHash: string | null;
  riskFlags: PromotionRiskFlag[];
}) {
  const periodEnd = addBillingPeriod(new Date(), billingInterval);
  await prisma.$transaction(async (tx) => {
    if (promotion) {
      if (!promotion.maxRedemptions || !promotion.endsAt || !clientIpHash) {
        throw new Error("PROMOTION_POLICY_INCOMPLETE");
      }
      const updatedPromotion = await tx.billingPromotion.updateMany({
        where: {
          id: promotion.id,
          isActive: true,
          endsAt: { gt: new Date() },
          redeemedCount: { lt: promotion.maxRedemptions },
        },
        data: { redeemedCount: { increment: 1 } },
      });

      if (updatedPromotion.count !== 1) {
        throw new Error("PROMOTION_REDEMPTION_LIMIT_REACHED");
      }

      await tx.billingPromotionRedemption.create({
        data: {
          promotionId: promotion.id,
          userId,
          planId,
          billingInterval,
          clientIpHash,
          riskFlags: encodePromotionRiskFlags(riskFlags),
        },
      });
    }

    await tx.user.update({
      where: { id: userId },
      data: {
        plan: tierForPlanId(planId),
        stripeSubscriptionId: null,
        stripePriceId: null,
        subscriptionStatus: "active",
        subscriptionCurrentPeriodEnd: periodEnd,
        subscriptionBillingInterval: billingInterval,
        subscriptionCancelAtPeriodEnd: false,
      },
    });
  });

  return periodEnd;
}

async function ensureStripeDiscount(
  promotion: CheckoutPromotion,
  planId: BillingPlanId
): Promise<Stripe.Checkout.SessionCreateParams.Discount> {
  if (promotion.stripePromotionCodeId) {
    return { promotion_code: promotion.stripePromotionCodeId };
  }

  const stripe = getStripe();
  if (!promotion.maxRedemptions || !promotion.endsAt) {
    throw new Error("Promotion limits are not configured.");
  }
  const couponId =
    promotion.stripeCouponId ||
    (
      await stripe.coupons.create({
        name: `${promotion.code} ${planId.toUpperCase()}`,
        duration: "repeating",
        duration_in_months: promotion.durationMonths,
        percent_off:
          promotion.discountPercent > 0 ? promotion.discountPercent : undefined,
        amount_off:
          promotion.discountPercent > 0
            ? undefined
            : promotion.discountAmountCents || undefined,
        currency: promotion.discountPercent > 0 ? undefined : "usd",
        metadata: {
          tomversePromotionId: promotion.id,
          planId,
        },
      })
    ).id;
  const promotionCode = await stripe.promotionCodes.create({
    promotion: { type: "coupon", coupon: couponId },
    code: promotion.code,
    active: true,
    max_redemptions: promotion.maxRedemptions,
    expires_at: Math.floor(new Date(promotion.endsAt).getTime() / 1000),
    metadata: {
      tomversePromotionId: promotion.id,
      planId,
    },
  });

  await prisma.billingPromotion.update({
    where: { id: promotion.id },
    data: {
      stripeCouponId: couponId,
      stripePromotionCodeId: promotionCode.id,
    },
  });

  return { promotion_code: promotionCode.id };
}

async function createCheckoutSession(params: Stripe.Checkout.SessionCreateParams) {
  return getStripe().checkout.sessions.create(params);
}

function buildCheckoutLineItem(
  plan: CheckoutPlan,
  billingInterval: "monthly" | "annual"
): Stripe.Checkout.SessionCreateParams.LineItem {
  if (billingInterval === "monthly") {
    if (plan.stripePriceId) {
      return { price: plan.stripePriceId, quantity: 1 };
    }
    if (plan.monthlyPriceCents <= 0) {
      throw new Error("Monthly price is not configured.");
    }
    return {
      quantity: 1,
      price_data: {
        currency: "usd",
        unit_amount: plan.monthlyPriceCents,
        product: plan.stripeProductId || undefined,
        product_data: plan.stripeProductId
          ? undefined
          : {
              name: `Tomverse AI ${plan.name}`,
              metadata: {
                planId: plan.id,
                tier: plan.tier,
              },
            },
        recurring: {
          interval: "month",
        },
      },
    };
  }

  if (plan.stripeAnnualPriceId) {
    return { price: plan.stripeAnnualPriceId, quantity: 1 };
  }

  if (plan.annualPriceCents <= 0) {
    throw new Error("Annual price is not configured.");
  }

  return {
    quantity: 1,
    price_data: {
      currency: "usd",
      unit_amount: plan.annualPriceCents,
      product: plan.stripeProductId || undefined,
      product_data: plan.stripeProductId
        ? undefined
        : {
            name: `Tomverse AI ${plan.name}`,
            metadata: {
              planId: plan.id,
              tier: plan.tier,
            },
          },
      recurring: {
        interval: "year",
      },
    },
  };
}

export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json(
        { error: "Authentication required." },
        { status: 401 }
      );
    }

    await consumeApiRateLimit(req, session.user.id, "billing-checkout-create", {
      minute: 5,
      day: 20,
    });

    const {
      planId,
      billingInterval,
      language,
      promoCode,
      analytics,
      trigger,
    } = await readLimitedJson(req, 4 * 1024, checkoutSchema);
    const plans = await getBillingPlans();
    const plan = plans.find((item) => item.id === planId && item.isActive);
    if (!plan) {
      return NextResponse.json(
        { error: "This plan is not ready for checkout yet." },
        { status: 503 }
      );
    }

    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: {
        id: true,
        email: true,
        name: true,
        stripeCustomerId: true,
        stripeSubscriptionId: true,
        subscriptionStatus: true,
        plan: true,
        creditDebtCredits: true,
        settings: {
          select: { language: true },
        },
      },
    });
    if (!user) {
      return NextResponse.json({ error: "User not found." }, { status: 404 });
    }
    if (
      user.stripeSubscriptionId &&
      user.subscriptionStatus &&
      activeSubscriptionStatuses.has(user.subscriptionStatus)
    ) {
      return NextResponse.json(
        { error: "An active subscription already exists." },
        { status: 409 }
      );
    }

    let appliedPromotion: CheckoutPromotion | null = null;
    let promotionClientIpHash: string | null = null;
    let promotionRiskFlags: PromotionRiskFlag[] = [];
    if (promoCode) {
      const promotionValidation = await validatePromotionForCheckout({
        code: promoCode,
        planId: planId as BillingPlanId,
        billingInterval,
        userId: user.id,
        request: req,
      });
      if (!promotionValidation.valid) {
        const validationError = promotionValidationError(
          promotionValidation.reason
        );
        return NextResponse.json(
          {
            code: validationError.code,
            error: validationError.message,
          },
          { status: validationError.status }
        );
      }
      appliedPromotion = promotionValidation.promotion;
      promotionClientIpHash = promotionValidation.clientIpHash;
      promotionRiskFlags = promotionValidation.riskFlags;
    }

    const finalPriceCents = calculateDiscountedCents(
      priceCentsForInterval(plan, billingInterval),
      appliedPromotion
    );
    const edgeCountry = analyticsCountryFromHeaders(req.headers);
    const trustedAnalytics = analytics
      ? {
          ...analytics,
          country: edgeCountry === "ZZ" ? analytics.country : edgeCountry,
        }
      : null;
    const currentPlan =
      user.plan === "Max" ? "Max" : user.plan === "Pro" ? "Pro" : "Free";
    const productId = `subscription_${planId}_${billingInterval}`;
    const purchaseSnapshot = trustedAnalytics
      ? await getPurchaseAnalyticsSnapshot({
          userId: user.id,
          currentPlan,
          creditDebtCredits: user.creditDebtCredits,
        }).catch((snapshotError) => {
          console.warn("Subscription purchase analytics snapshot failed.", {
            errorName:
              snapshotError instanceof Error
                ? snapshotError.name
                : "UnknownError",
          });
          return null;
        })
      : null;
    const purchaseContext = purchaseSnapshot?.context || {
      currentPlan:
        currentPlan === "Max" ? "max" : currentPlan === "Pro" ? "pro" : "free",
      planCreditsRemaining: 0,
      addonCreditsRemaining: 0,
    };
    const analyticsMetadata: Record<string, string> = trustedAnalytics
      ? {
          analyticsClientId: trustedAnalytics.client_id,
          analyticsSessionId: trustedAnalytics.session_id,
          analyticsUtmSource: trustedAnalytics.utm_source,
          analyticsUtmMedium: trustedAnalytics.utm_medium,
          analyticsUtmCampaign: trustedAnalytics.utm_campaign,
          analyticsLanguage: trustedAnalytics.language,
          analyticsCountry: trustedAnalytics.country,
          analyticsValue: String(finalPriceCents / 100),
          ...purchaseAnalyticsMetadata({
            context: purchaseContext,
            trigger,
            productId,
            creditsPurchased: plan.monthlyMessageLimit,
          }),
        }
      : {};
    const origin = getPublicAppOrigin(req);
    if (finalPriceCents <= 0) {
      const periodEnd = await activateZeroDollarPlan({
        userId: user.id,
        planId: planId as BillingPlanId,
        billingInterval,
        promotion: appliedPromotion,
        clientIpHash: promotionClientIpHash,
        riskFlags: promotionRiskFlags,
      });
      await sendBillingWelcomeEmail({
        to: user.email,
        plan: tierForPlanId(planId),
        billingInterval,
        periodEnd,
        language: user.settings?.language,
      }).catch((emailError) => {
        console.error("Billing welcome email failed:", emailError);
      });
      if (trustedAnalytics) {
        const transactionId = `zero-${randomUUID()}`;
        await recordProductAnalyticsEvent({
          eventName: "purchase_completed",
          source: "server",
          userId: user.id,
          attribution: trustedAnalytics,
          modelCount: 0,
          plan: tierForPlanId(planId),
          properties: {
            billing_interval: billingInterval,
            plan_id: planId,
            purchase_type: "subscription",
            product_id: productId,
            credits_purchased: plan.monthlyMessageLimit,
            current_plan: purchaseContext.currentPlan,
            trigger,
            plan_credits_remaining: purchaseContext.planCreditsRemaining,
            addon_credits_remaining: purchaseContext.addonCreditsRemaining,
            value: 0,
            currency: "USD",
            transaction_id: transactionId,
          },
          dedupeKey: `zero-checkout:${transactionId}`,
          sendToGa4: true,
        }).catch((analyticsError) => {
          console.warn("Zero-dollar purchase analytics failed.", {
            errorName:
              analyticsError instanceof Error
                ? analyticsError.name
                : "UnknownError",
          });
        });
      }

      return NextResponse.json({
        success: true,
        redirectUrl: billingSuccessUrl(
          origin,
          planId as BillingPlanId,
          billingInterval,
          language
        ),
        periodEnd: periodEnd.toISOString(),
      });
    }

    const stripe = getStripe();
    let stripeCustomerId = user.stripeCustomerId;
    if (!stripeCustomerId) {
      const customer = await stripe.customers.create({
        email: user.email || undefined,
        name: user.name || undefined,
        metadata: { userId: user.id },
      });
      stripeCustomerId = customer.id;
      await prisma.user.update({
        where: { id: user.id },
        data: { stripeCustomerId },
      });
    }

    let promotionLeaseReserved = false;
    if (appliedPromotion) {
      await reservePromotionCheckout(appliedPromotion.id, user.id);
      promotionLeaseReserved = true;
    }
    try {
      const discount = appliedPromotion
        ? await ensureStripeDiscount(appliedPromotion, planId as BillingPlanId)
        : null;
      const promotionMetadata: Record<string, string> = {};
      if (appliedPromotion) {
        promotionMetadata.promotionId = appliedPromotion.id;
        promotionMetadata.promotionIpHash = promotionClientIpHash || "";
        promotionMetadata.promotionRiskFlags =
          encodePromotionRiskFlags(promotionRiskFlags);
      }
      const checkoutSession = await createCheckoutSession({
        mode: "subscription",
        customer: stripeCustomerId,
        line_items: [buildCheckoutLineItem(plan, billingInterval)],
        success_url: billingSuccessUrl(
          origin,
          planId as BillingPlanId,
          billingInterval,
          language
        ),
        cancel_url: `${origin}/pricing?billing=cancelled`,
        expires_at: appliedPromotion
          ? Math.floor(Date.now() / 1000) + PROMOTION_CHECKOUT_TTL_SECONDS
          : undefined,
        client_reference_id: user.id,
        allow_promotion_codes: false,
        discounts: discount ? [discount] : undefined,
        subscription_data: {
          metadata: {
            userId: user.id,
            planId,
            tier: tierForPlanId(planId),
            billingInterval,
            ...promotionMetadata,
            ...analyticsMetadata,
          },
        },
        metadata: {
          userId: user.id,
          planId,
          billingInterval,
          ...promotionMetadata,
          ...analyticsMetadata,
        },
      });

      return NextResponse.json({ url: checkoutSession.url });
    } catch (error) {
      if (promotionLeaseReserved && appliedPromotion) {
        await releasePromotionCheckout(appliedPromotion.id, user.id).catch(
          () => undefined
        );
      }
      throw error;
    }
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    if (
      error instanceof Error &&
      error.message === "PROMOTION_REDEMPTION_LIMIT_REACHED"
    ) {
      return NextResponse.json(
        { error: "This promotion code has reached its redemption limit." },
        { status: 409 }
      );
    }
    console.error("Stripe checkout failed:", error);
    return NextResponse.json(
      { error: "Failed to start checkout." },
      { status: 500 }
    );
  }
}
