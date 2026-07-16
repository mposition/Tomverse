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
import { sendFoundingTesterPassStartedEmail } from "@/lib/billingEmails";
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
import {
  BillingMarketValidationError,
  validateBillingMarketRequest,
} from "@/lib/billingCurrency";
import {
  getBillingPriceCatalog,
  getPlanPriceMinor,
  getUsdRevenueSnapshot,
} from "@/lib/billingPriceCatalog";
import {
  billingMinorToMajor,
  BILLING_CURRENCIES,
  type BillingCurrency,
} from "@/lib/billingMarkets";
import { checkoutBillingMetadata } from "@/lib/billingTransactions";
import {
  FOUNDING_TESTER_PASS_STATUS,
  addUtcDays,
  isInternalPassPromotion,
} from "@/lib/foundingTesterPassCore";

const checkoutSchema = z
  .object({
    planId: z.enum(["pro", "max"]),
    billingInterval: z.enum(["monthly", "annual"]).default("monthly"),
    language: z.enum(["ko", "en", "zh", "fr", "de", "es", "pt"]).optional(),
    promoCode: z.string().trim().toUpperCase().max(32).optional(),
    analytics: analyticsAttributionSchema.optional(),
    trigger: purchaseAnalyticsTriggerSchema.default("proactive"),
    currency: z.enum(BILLING_CURRENCIES).optional(),
    country: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/).optional(),
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

const billingSuccessUrl = (
  origin: string,
  planId: BillingPlanId,
  billingInterval: "monthly" | "annual",
  language?: "ko" | "en" | "zh" | "fr" | "de" | "es" | "pt",
  accessType?: "founding-tester-pass"
) =>
  `${origin}/chat?billing=success&plan=${encodeURIComponent(
    planId
  )}&interval=${encodeURIComponent(billingInterval)}${
    language ? `&lang=${encodeURIComponent(language)}` : ""
  }${accessType ? `&access=${encodeURIComponent(accessType)}` : ""}`;

async function activateInternalPass({
  userId,
  planId,
  promotion,
  clientIpHash,
  riskFlags,
}: {
  userId: string;
  planId: BillingPlanId;
  promotion: CheckoutPromotion;
  clientIpHash: string | null;
  riskFlags: PromotionRiskFlag[];
}) {
  if (
    !isInternalPassPromotion(promotion) ||
    promotion.discountPercent !== 100 ||
    promotion.appliesToPlanIds.length !== 1 ||
    promotion.appliesToPlanIds[0] !== "pro" ||
    !promotion.accessDurationDays
  ) {
    throw new Error("INTERNAL_PASS_POLICY_INVALID");
  }
  const accessStartsAt = new Date();
  const periodEnd = addUtcDays(accessStartsAt, promotion.accessDurationDays);
  await prisma.$transaction(async (tx) => {
    if (!promotion.maxRedemptions || !promotion.endsAt || !clientIpHash) {
      throw new Error("PROMOTION_POLICY_INCOMPLETE");
    }
    const updatedPromotion = await tx.billingPromotion.updateMany({
      where: {
        id: promotion.id,
        fulfillmentType: "internal_pass",
        isActive: true,
        endsAt: { gt: accessStartsAt },
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
        billingInterval: "internal_pass",
        clientIpHash,
        riskFlags: encodePromotionRiskFlags(riskFlags),
        accessStartsAt,
        accessEndsAt: periodEnd,
      },
    });

    await tx.user.update({
      where: { id: userId },
      data: {
        plan: tierForPlanId(planId),
        stripeSubscriptionId: null,
        stripePriceId: null,
        subscriptionStatus: FOUNDING_TESTER_PASS_STATUS,
        subscriptionCurrentPeriodEnd: periodEnd,
        subscriptionBillingInterval: null,
        subscriptionCancelAtPeriodEnd: true,
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
  billingInterval: "monthly" | "annual",
  currency: BillingCurrency,
  amountMinor: number
): Stripe.Checkout.SessionCreateParams.LineItem {
  if (billingInterval === "monthly") {
    if (amountMinor <= 0) {
      throw new Error("Monthly price is not configured.");
    }
    return {
      quantity: 1,
      price_data: {
        currency: currency.toLowerCase(),
        unit_amount: amountMinor,
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

  if (amountMinor <= 0) {
    throw new Error("Annual price is not configured.");
  }

  return {
    quantity: 1,
    price_data: {
      currency: currency.toLowerCase(),
      unit_amount: amountMinor,
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
      currency,
      country,
    } = await readLimitedJson(req, 4 * 1024, checkoutSchema);
    const plans = await getBillingPlans();
    const plan = plans.find((item) => item.id === planId && item.isActive);
    if (!plan) {
      return NextResponse.json(
        { error: "This plan is not ready for checkout yet." },
        { status: 503 }
      );
    }
    const market = validateBillingMarketRequest({ req, currency, country });
    const priceCatalog = await getBillingPriceCatalog();
    const basePriceMinor = getPlanPriceMinor(
      plan,
      market.currency,
      billingInterval,
      priceCatalog
    );
    const baseUsdCents = priceCentsForInterval(plan, billingInterval);

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

    if (
      market.currency !== "USD" &&
      appliedPromotion?.discountAmountCents &&
      appliedPromotion.discountPercent <= 0
    ) {
      return NextResponse.json(
        {
          error:
            "Fixed-amount promotion codes are currently available only for USD checkout. Use a percentage promotion for localized billing.",
        },
        { status: 400 }
      );
    }

    const finalPriceMinor = calculateDiscountedCents(
      basePriceMinor,
      appliedPromotion
    );
    const finalUsdCents = calculateDiscountedCents(baseUsdCents, appliedPromotion);
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
          analyticsValue: String(
            billingMinorToMajor(finalPriceMinor, market.currency)
          ),
          analyticsCurrency: market.currency,
          ...purchaseAnalyticsMetadata({
            context: purchaseContext,
            trigger,
            productId,
            creditQuantity: plan.monthlyMessageLimit,
          }),
        }
      : {};
    const origin = getPublicAppOrigin(req);
    const internalPass =
      appliedPromotion && isInternalPassPromotion(appliedPromotion)
        ? appliedPromotion
        : null;
    if (internalPass) {
      if (billingInterval !== "monthly" || finalPriceMinor !== 0) {
        return NextResponse.json(
          { error: "This access pass is available only for the monthly Pro plan." },
          { status: 400 }
        );
      }
      const periodEnd = await activateInternalPass({
        userId: user.id,
        planId: planId as BillingPlanId,
        promotion: internalPass,
        clientIpHash: promotionClientIpHash,
        riskFlags: promotionRiskFlags,
      });
      await sendFoundingTesterPassStartedEmail({
        to: user.email,
        periodEnd,
        language: user.settings?.language,
      }).catch((emailError) => {
        console.error("Founding Tester Pass welcome email failed:", emailError);
      });
      if (trustedAnalytics) {
        const activationId = `pass-${randomUUID()}`;
        await recordProductAnalyticsEvent({
          eventName: "promotion_pass_activated",
          source: "server",
          userId: user.id,
          attribution: trustedAnalytics,
          modelCount: 0,
          plan: tierForPlanId(planId),
          properties: {
            plan_id: planId,
            product_id: "founding_tester_pass_pro_60d",
            promotion_code: internalPass.code,
            access_duration_days: internalPass.accessDurationDays || 60,
            automatic_renewal: false,
            monthly_credits_included: plan.monthlyMessageLimit,
            current_plan: purchaseContext.currentPlan,
            trigger,
            plan_credits_remaining: purchaseContext.planCreditsRemaining,
            addon_credits_remaining: purchaseContext.addonCreditsRemaining,
          },
          dedupeKey: `promotion-pass:${activationId}`,
          sendToGa4: true,
        }).catch((analyticsError) => {
          console.warn("Founding Tester Pass analytics failed.", {
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
          language,
          "founding-tester-pass"
        ),
        periodEnd: periodEnd.toISOString(),
        accessType: "founding_tester_pass",
        automaticRenewal: false,
        paymentMethodRequired: false,
      });
    }

    const usdRevenueSnapshot = await getUsdRevenueSnapshot({
      amountMinor: finalPriceMinor,
      currency: market.currency,
      fallbackUsdMinor: finalUsdCents,
    });
    const billingMetadata = checkoutBillingMetadata({
      currency: market.currency,
      country: market.country,
      expectedAmountMinor: finalPriceMinor,
      amountUsdMicroUsd: usdRevenueSnapshot.amountUsdMicroUsd,
      usdConversionRate: usdRevenueSnapshot.usdConversionRate,
      usdConversionSource: usdRevenueSnapshot.source,
      pricingVersion: priceCatalog.version,
    });

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
        line_items: [
          buildCheckoutLineItem(
            plan,
            billingInterval,
            market.currency,
            basePriceMinor
          ),
        ],
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
            ...billingMetadata,
            ...promotionMetadata,
            ...analyticsMetadata,
          },
        },
        metadata: {
          userId: user.id,
          planId,
          billingInterval,
          ...billingMetadata,
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
    if (error instanceof BillingMarketValidationError) {
      return NextResponse.json(
        { code: error.code, error: error.message },
        { status: 400 }
      );
    }
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
