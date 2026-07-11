export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { z } from "zod";
import { authOptions } from "@/lib/auth";
import { isAdminSession } from "@/lib/adminAuth";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
  readLimitedJson,
} from "@/lib/apiSecurity";
import { getBillingPlans, getBillingPromotions } from "@/lib/billingConfig";
import { prisma } from "@/lib/prisma";

const optionalText = z
  .string()
  .trim()
  .max(255)
  .transform((value) => (value.length > 0 ? value : null))
  .nullable()
  .optional();

const planSchema = z
  .object({
    id: z.enum(["free", "pro", "max"]),
    monthlyPriceCents: z.number().int().min(0).max(1_000_000),
    dailyMessageLimit: z.number().int().min(0).max(1_000_000),
    monthlyMessageLimit: z.number().int().min(0).max(10_000_000),
    maxModels: z.number().int().min(1).max(10),
    allowAttachments: z.boolean(),
    allowSharing: z.boolean(),
    allowDownloads: z.boolean(),
    isActive: z.boolean(),
    stripeProductId: optionalText,
    stripePriceId: optionalText,
  })
  .strict();

const promotionSchema = z
  .object({
    id: z.string().trim().min(1).max(120).optional(),
    code: z.string().trim().toUpperCase().min(2).max(32),
    discountPercent: z.number().int().min(1).max(100),
    durationMonths: z.number().int().min(1).max(36),
    appliesToPlanIds: z.array(z.enum(["pro", "max"])).min(1).max(2),
    stripeCouponId: optionalText,
    stripePromotionCodeId: optionalText,
    isActive: z.boolean(),
  })
  .strict();

const updateBillingSchema = z
  .object({
    plans: z.array(planSchema).min(1).max(3).optional(),
    promotions: z.array(promotionSchema).max(10).optional(),
  })
  .strict();

const planName = (id: "free" | "pro" | "max") =>
  id === "max" ? "Max" : id === "pro" ? "Pro" : "Free";

export async function GET(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    await consumeApiRateLimit(req, session.user.id, "admin-billing-read", {
      minute: 30,
      day: 500,
    });
    const [plans, promotions] = await Promise.all([
      getBillingPlans(),
      getBillingPromotions(),
    ]);
    return NextResponse.json({ plans, promotions });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Failed to load admin billing:", error);
    return NextResponse.json(
      { error: "Failed to load billing settings." },
      { status: 500 }
    );
  }
}

export async function PATCH(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    await consumeApiRateLimit(req, session.user.id, "admin-billing-write", {
      minute: 10,
      day: 100,
    });
    const body = await readLimitedJson(req, 32 * 1024, updateBillingSchema);

    for (const plan of body.plans || []) {
      await prisma.billingPlan.upsert({
        where: { id: plan.id },
        create: {
          id: plan.id,
          name: planName(plan.id),
          tier: planName(plan.id),
          monthlyPriceCents: plan.monthlyPriceCents,
          currency: "USD",
          stripeProductId: plan.stripeProductId,
          stripePriceId: plan.stripePriceId,
          dailyMessageLimit: plan.dailyMessageLimit,
          monthlyMessageLimit: plan.monthlyMessageLimit,
          maxModels: plan.maxModels,
          allowAttachments: plan.allowAttachments,
          allowSharing: plan.allowSharing,
          allowDownloads: plan.allowDownloads,
          isActive: plan.isActive,
          sortOrder: plan.id === "free" ? 10 : plan.id === "pro" ? 20 : 30,
        },
        update: {
          monthlyPriceCents: plan.monthlyPriceCents,
          stripeProductId: plan.stripeProductId,
          stripePriceId: plan.stripePriceId,
          dailyMessageLimit: plan.dailyMessageLimit,
          monthlyMessageLimit: plan.monthlyMessageLimit,
          maxModels: plan.maxModels,
          allowAttachments: plan.allowAttachments,
          allowSharing: plan.allowSharing,
          allowDownloads: plan.allowDownloads,
          isActive: plan.isActive,
        },
      });
    }

    for (const promotion of body.promotions || []) {
      const id = promotion.id || `promo_${promotion.code.toLowerCase()}`;
      await prisma.billingPromotion.upsert({
        where: { id },
        create: {
          id,
          code: promotion.code,
          discountPercent: promotion.discountPercent,
          durationMonths: promotion.durationMonths,
          appliesToPlanIds: JSON.stringify(promotion.appliesToPlanIds),
          stripeCouponId: promotion.stripeCouponId,
          stripePromotionCodeId: promotion.stripePromotionCodeId,
          isActive: promotion.isActive,
        },
        update: {
          code: promotion.code,
          discountPercent: promotion.discountPercent,
          durationMonths: promotion.durationMonths,
          appliesToPlanIds: JSON.stringify(promotion.appliesToPlanIds),
          stripeCouponId: promotion.stripeCouponId,
          stripePromotionCodeId: promotion.stripePromotionCodeId,
          isActive: promotion.isActive,
        },
      });
    }

    const [plans, promotions] = await Promise.all([
      getBillingPlans(),
      getBillingPromotions(),
    ]);
    return NextResponse.json({ plans, promotions });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Failed to update admin billing:", error);
    return NextResponse.json(
      { error: "Failed to update billing settings." },
      { status: 500 }
    );
  }
}
