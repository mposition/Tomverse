export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
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
    promoCode: z.string().trim().toUpperCase().max(32).optional(),
  })
  .strict();

const activeSubscriptionStatuses = new Set(["active", "trialing", "past_due"]);

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

    const { planId, promoCode } = await readLimitedJson(req, 4 * 1024, checkoutSchema);
    const plans = await getBillingPlans();
    const plan = plans.find((item) => item.id === planId && item.isActive);
    if (!plan || !plan.stripePriceId) {
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
            item.isActive &&
            item.code === promoCode &&
            item.appliesToPlanIds.includes(planId as BillingPlanId)
        )
      : null;
    if (promoCode && !promotion) {
      return NextResponse.json(
        { error: "Invalid promotion code." },
        { status: 400 }
      );
    }
    if (promotion && !promotion.stripePromotionCodeId && !promotion.stripeCouponId) {
      return NextResponse.json(
        { error: "Promotion code is not configured in Stripe yet." },
        { status: 503 }
      );
    }

    const origin = getPublicAppOrigin(req);
    const checkoutSession = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: stripeCustomerId,
      line_items: [{ price: plan.stripePriceId, quantity: 1 }],
      success_url: `${origin}/chat?billing=success`,
      cancel_url: `${origin}/pricing?billing=cancelled`,
      client_reference_id: user.id,
      allow_promotion_codes: !promotion,
      discounts: promotion
        ? [
            promotion.stripePromotionCodeId
              ? { promotion_code: promotion.stripePromotionCodeId }
              : { coupon: promotion.stripeCouponId as string },
          ]
        : undefined,
      subscription_data: {
        metadata: {
          userId: user.id,
          planId,
          tier: tierForPlanId(planId),
        },
      },
      metadata: {
        userId: user.id,
        planId,
        promoCode: promotion?.code || "",
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
