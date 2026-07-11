export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
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
  getBillingPromotions,
  tierForPlanId,
  type BillingPlanId,
} from "@/lib/billingConfig";
import { prisma } from "@/lib/prisma";
import { getPublicAppOrigin } from "@/lib/publicUrl";
import { getStripe } from "@/lib/stripe";

const checkoutSchema = z
  .object({
    planId: z.enum(["pro", "max"]),
    billingInterval: z.enum(["monthly", "annual"]).default("monthly"),
    promoCode: z.string().trim().toUpperCase().max(32).optional(),
  })
  .strict();

const activeSubscriptionStatuses = new Set(["active", "trialing", "past_due"]);

type CheckoutPromotion = Awaited<ReturnType<typeof getBillingPromotions>>[number];
type CheckoutPlan = Awaited<ReturnType<typeof getBillingPlans>>[number];

const isPromotionCurrentlyRedeemable = (
  promotion: CheckoutPromotion,
  planId: BillingPlanId,
  now = new Date()
) => {
  if (!promotion.isActive) return false;
  if (!promotion.appliesToPlanIds.includes(planId)) return false;
  if (promotion.startsAt && new Date(promotion.startsAt) > now) return false;
  if (promotion.endsAt && new Date(promotion.endsAt) < now) return false;
  if (
    promotion.maxRedemptions &&
    promotion.redeemedCount >= promotion.maxRedemptions
  ) {
    return false;
  }
  return promotion.discountPercent > 0 || Boolean(promotion.discountAmountCents);
};

async function ensureStripeDiscount(
  promotion: CheckoutPromotion,
  planId: BillingPlanId
): Promise<Stripe.Checkout.SessionCreateParams.Discount> {
  if (promotion.stripeCouponId) {
    return { coupon: promotion.stripeCouponId };
  }

  const stripe = getStripe();
  const coupon = await stripe.coupons.create({
    name: `${promotion.code} ${planId.toUpperCase()}`,
    duration: "repeating",
    duration_in_months: promotion.durationMonths,
    percent_off:
      promotion.discountPercent > 0 ? promotion.discountPercent : undefined,
    amount_off:
      promotion.discountPercent > 0
        ? undefined
        : promotion.discountAmountCents || undefined,
    currency:
      promotion.discountPercent > 0 ? undefined : "usd",
    metadata: {
      tomversePromotionId: promotion.id,
      tomverseCode: promotion.code,
      planId,
    },
  });

  let promotionCodeId: string | null = null;
  try {
    const promotionCode = await stripe.promotionCodes.create({
      promotion: { type: "coupon", coupon: coupon.id },
      code: promotion.code,
      active: promotion.isActive,
      max_redemptions: promotion.maxRedemptions || undefined,
      expires_at: promotion.endsAt
        ? Math.floor(new Date(promotion.endsAt).getTime() / 1000)
        : undefined,
      metadata: {
        tomversePromotionId: promotion.id,
        planId,
      },
    });
    promotionCodeId = promotionCode.id;
  } catch {
    promotionCodeId = null;
  }

  await prisma.billingPromotion.update({
    where: { id: promotion.id },
    data: {
      stripeCouponId: coupon.id,
      stripePromotionCodeId: promotionCodeId,
    },
  });

  return { coupon: coupon.id };
}

async function createCheckoutSessionWithPaymentFallback(
  params: Stripe.Checkout.SessionCreateParams
) {
  const stripe = getStripe();
  const paypalEnabled = process.env.STRIPE_ENABLE_PAYPAL !== "false";
  const preferredPaymentMethods: Stripe.Checkout.SessionCreateParams.PaymentMethodType[] =
    paypalEnabled ? ["card", "paypal"] : ["card"];

  try {
    return await stripe.checkout.sessions.create({
      ...params,
      payment_method_types: preferredPaymentMethods,
    });
  } catch (error) {
    if (!paypalEnabled) throw error;
    console.warn("Stripe PayPal checkout failed; retrying with card only.");
    return stripe.checkout.sessions.create({
      ...params,
      payment_method_types: ["card"],
    });
  }
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

    const { planId, billingInterval, promoCode } = await readLimitedJson(
      req,
      4 * 1024,
      checkoutSchema
    );
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

    const promotions = await getBillingPromotions();
    const promotion = promoCode
      ? promotions.find(
          (item) =>
            item.code === promoCode &&
            isPromotionCurrentlyRedeemable(item, planId as BillingPlanId)
        )
      : null;
    if (promoCode && !promotion) {
      return NextResponse.json(
        { error: "Invalid promotion code." },
        { status: 400 }
      );
    }
    const discount = promotion
      ? await ensureStripeDiscount(promotion, planId as BillingPlanId)
      : null;

    const origin = getPublicAppOrigin(req);
    const checkoutSession = await createCheckoutSessionWithPaymentFallback({
      mode: "subscription",
      customer: stripeCustomerId,
      line_items: [buildCheckoutLineItem(plan, billingInterval)],
      success_url: `${origin}/chat?billing=success`,
      cancel_url: `${origin}/pricing?billing=cancelled`,
      client_reference_id: user.id,
      allow_promotion_codes: !promotion,
      discounts: discount ? [discount] : undefined,
      subscription_data: {
        metadata: {
          userId: user.id,
          planId,
          tier: tierForPlanId(planId),
          billingInterval,
          promoCode: promotion?.code || "",
          promotionId: promotion?.id || "",
        },
      },
      metadata: {
        userId: user.id,
        planId,
        billingInterval,
        promoCode: promotion?.code || "",
        promotionId: promotion?.id || "",
      },
    });

    return NextResponse.json({ url: checkoutSession.url });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Stripe checkout failed:", error);
    return NextResponse.json(
      { error: "Failed to start checkout." },
      { status: 500 }
    );
  }
}
