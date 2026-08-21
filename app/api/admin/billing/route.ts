export const dynamic = "force-dynamic";

import type { BillingPromotion } from "@prisma/client";
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { z } from "zod";
import { authOptions } from "@/lib/auth";
import { writeAdminAuditLog } from "@/lib/adminAudit";
import { hasAdminPermission, isAdminSession } from "@/lib/adminAuth";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
  readLimitedJson,
} from "@/lib/apiSecurity";
import {
  getPublicAppSettings,
  isValidGuestDefaultModel,
  updateGuestDefaultModel,
} from "@/lib/appSettings";
import {
  getBillingPlans,
  getBillingPromotions,
  syncBillingDefaultsToDatabase,
} from "@/lib/billingConfig";
import {
  PROMOTION_FIXED_AMOUNT_BLOCKED,
  fixedAmountPromotionRefusals,
  type AdminPromotionPolicyInput,
} from "@/lib/billingPromotionAdminPolicy";
import { prisma } from "@/lib/prisma";
import {
  BILLING_PRICE_CATALOG_KEY,
  billingPriceCatalogSchema,
  getBillingPriceCatalogWithMeta,
  saveBillingPriceCatalog,
} from "@/lib/billingPriceCatalog";

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
    name: z.string().trim().min(1).max(80).optional(),
    tier: z.enum(["Free", "Pro", "Max"]).optional(),
    monthlyPriceCents: z.number().int().min(0).max(1_000_000),
    annualPriceCents: z.number().int().min(0).max(10_000_000),
    currency: z.literal("USD").optional(),
    dailyMessageLimit: z.number().int().min(0).max(1_000_000),
    monthlyMessageLimit: z.number().int().min(0).max(10_000_000),
    maxModels: z.number().int().min(1).max(10),
    allowAttachments: z.boolean(),
    allowSharing: z.boolean(),
    allowDownloads: z.boolean(),
    isActive: z.boolean(),
    stripeProductId: optionalText,
    stripePriceId: optionalText,
    stripeAnnualPriceId: optionalText,
    sortOrder: z.number().int().min(0).max(1_000).optional(),
    updatedAt: z.string().datetime().nullable().optional(),
  })
  .strict();

const promotionSchema = z
  .object({
    id: z.string().trim().min(1).max(120).optional(),
    code: z.string().trim().toUpperCase().min(2).max(32),
    discountPercent: z.number().int().min(0).max(100),
    /**
     * @deprecated USD only, and not extended to other currencies
     * (docs/policy/promotion-discount-currency.md section 2). Still accepted so
     * the codes that already carry one can be narrowed and audited; what may
     * still be done to them is decided by `fixedAmountPromotionRefusal()`,
     * which needs the stored row and so cannot be a schema rule.
     */
    discountAmountCents: z.number().int().min(0).max(1_000_000).nullable().optional(),
    maxRedemptions: z.number().int().min(1).max(1_000_000).nullable().optional(),
    redeemedCount: z.number().int().min(0).max(1_000_000).optional(),
    durationMonths: z.number().int().min(1).max(36),
    fulfillmentType: z.enum(["stripe_subscription", "internal_pass"]),
    accessDurationDays: z.number().int().min(1).max(366).nullable().optional(),
    appliesToPlanIds: z.array(z.enum(["pro", "max"])).min(1).max(2),
    stripeCouponId: optionalText,
    stripePromotionCodeId: optionalText,
    startsAt: z.string().datetime().nullable().optional(),
    endsAt: z.string().datetime().nullable().optional(),
    allowAnnualStacking: z.boolean(),
    isActive: z.boolean(),
    updatedAt: z.string().datetime().nullable().optional(),
  })
  .refine(
    (promotion) =>
      promotion.discountPercent > 0 ||
      Boolean(promotion.discountAmountCents && promotion.discountAmountCents > 0),
    { message: "Promotion must have a percent or amount discount." }
  )
  .refine(
    (promotion) =>
      promotion.fulfillmentType !== "internal_pass" ||
      (promotion.discountPercent === 100 &&
        promotion.accessDurationDays !== null &&
        promotion.accessDurationDays !== undefined &&
        promotion.appliesToPlanIds.length === 1 &&
        promotion.appliesToPlanIds[0] === "pro" &&
        !promotion.allowAnnualStacking),
    {
      message:
        "Internal passes require 100% discount, a duration in days, Pro-only eligibility, and no annual stacking.",
    }
  )
  .refine(
    (promotion) =>
      !promotion.isActive ||
      (Boolean(promotion.maxRedemptions) && Boolean(promotion.endsAt)),
    {
      message:
        "Active promotions require a maximum redemption count and an end date.",
    }
  )
  .refine(
    (promotion) =>
      !promotion.startsAt ||
      !promotion.endsAt ||
      new Date(promotion.startsAt) < new Date(promotion.endsAt),
    { message: "Promotion end date must be after its start date." }
  )
  .strict();

const updateBillingSchema = z
  .object({
    plans: z.array(planSchema).min(1).max(3).optional(),
    promotions: z.array(promotionSchema).max(10).optional(),
    settings: z
      .object({
        guestDefaultModelId: z
          .string()
          .trim()
          .min(1)
          .max(100)
          // Eligibility is not the whole rule: the setting only reorders the
          // guest brand trio, so a model outside it saves cleanly and then
          // does nothing. lib/appSettings.ts spells out which is which.
          .refine(isValidGuestDefaultModel, {
            message:
              "Guest default model must be one of the guest brand-trio models, which are the only ones this setting can lead with.",
          }),
      })
      .strict()
      .optional(),
    priceCatalog: billingPriceCatalogSchema.optional(),
    priceCatalogUpdatedAt: z.string().datetime().nullable().optional(),
  })
  .strict();

type PromotionPayload = z.infer<typeof promotionSchema>;

const promotionRecordId = (promotion: PromotionPayload) =>
  promotion.id || `promo_${promotion.code.toLowerCase()}`;

const payloadPolicyInput = (
  promotion: PromotionPayload
): AdminPromotionPolicyInput => ({
  code: promotion.code,
  discountPercent: promotion.discountPercent,
  discountAmountCents: promotion.discountAmountCents || null,
  maxRedemptions: promotion.maxRedemptions || null,
  durationMonths: promotion.durationMonths,
  appliesToPlanIds: promotion.appliesToPlanIds,
  startsAt: promotion.startsAt || null,
  endsAt: promotion.endsAt || null,
  isActive: promotion.isActive,
});

const storedPolicyInput = (
  promotion: BillingPromotion
): AdminPromotionPolicyInput => {
  let appliesToPlanIds: string[] = [];
  try {
    const parsed = JSON.parse(promotion.appliesToPlanIds);
    if (Array.isArray(parsed)) {
      appliesToPlanIds = parsed.filter(
        (item): item is string => typeof item === "string"
      );
    }
  } catch {
    // A row whose plan list will not parse is treated as applying to nothing,
    // so every plan in the payload reads as newly added and the edit is
    // refused. Guessing the wider set here would let a malformed row be a way
    // through the check.
  }
  return {
    code: promotion.code,
    discountPercent: promotion.discountPercent,
    discountAmountCents: promotion.discountAmountCents,
    maxRedemptions: promotion.maxRedemptions,
    durationMonths: promotion.durationMonths,
    appliesToPlanIds,
    startsAt: promotion.startsAt?.toISOString() || null,
    endsAt: promotion.endsAt?.toISOString() || null,
    isActive: promotion.isActive,
  };
};

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
    await syncBillingDefaultsToDatabase();
    const [plans, promotions, settings, pricing] = await Promise.all([
      getBillingPlans(),
      getBillingPromotions(),
      getPublicAppSettings(),
      getBillingPriceCatalogWithMeta(),
    ]);
    return NextResponse.json({
      plans,
      promotions,
      settings,
      priceCatalog: pricing.catalog,
      priceCatalogUpdatedAt: pricing.updatedAt,
      priceCatalogSource: pricing.source,
    });
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
    if (!hasAdminPermission(session, "billing:write")) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }
    await consumeApiRateLimit(req, session.user.id, "admin-billing-write", {
      minute: 10,
      day: 100,
    });
    const body = await readLimitedJson(req, 64 * 1024, updateBillingSchema);
    await syncBillingDefaultsToDatabase();

    const existingPlans = await prisma.billingPlan.findMany({
      select: { id: true, updatedAt: true },
    });
    const existingPlanUpdatedAt = new Map(
      existingPlans.map((plan) => [plan.id, plan.updatedAt.toISOString()])
    );
    for (const plan of body.plans || []) {
      const currentUpdatedAt = existingPlanUpdatedAt.get(plan.id);
      if (currentUpdatedAt && plan.updatedAt && currentUpdatedAt !== plan.updatedAt) {
        return NextResponse.json(
          { error: `Billing plan ${plan.id} was changed by another admin. Reload before saving.` },
          { status: 409 }
        );
      }
    }

    // Read once and keep the whole row: the optimistic-concurrency check, the
    // fixed-amount policy gate and the upsert loop below all need the stored
    // promotion, and re-reading it per promotion per purpose invites the three
    // to disagree about what "existing" was.
    const existingPromotions = await prisma.billingPromotion.findMany();
    const existingPromotionById = new Map(
      existingPromotions.map((promotion) => [promotion.id, promotion])
    );
    for (const promotion of body.promotions || []) {
      const current = existingPromotionById.get(promotionRecordId(promotion));
      if (
        current &&
        promotion.updatedAt &&
        current.updatedAt.toISOString() !== promotion.updatedAt
      ) {
        return NextResponse.json(
          { error: `Promotion ${promotion.code} was changed by another admin. Reload before saving.` },
          { status: 409 }
        );
      }
    }

    // Fixed-amount promotions are deprecated, not deleted: existing codes may
    // be narrowed or switched off, nothing may create or widen one.
    // docs/policy/promotion-discount-currency.md section 4 is the matrix; this
    // is where it is enforced, before any write, so a refused save changes
    // nothing at all. The Admin panel refuses the same edits, but the panel is
    // not the only client this endpoint has.
    const promotionRefusals = fixedAmountPromotionRefusals(
      (body.promotions || []).map((promotion) => {
        const current = existingPromotionById.get(promotionRecordId(promotion));
        return {
          existing: current ? storedPolicyInput(current) : null,
          next: payloadPolicyInput(promotion),
        };
      })
    );
    if (promotionRefusals.length > 0) {
      return NextResponse.json(
        {
          error: promotionRefusals
            .map((item) => `${item.code}: ${item.message}`)
            .join(" "),
          code: PROMOTION_FIXED_AMOUNT_BLOCKED,
          refusals: promotionRefusals,
        },
        { status: 400 }
      );
    }

    if (body.priceCatalog) {
      const currentPricing = await prisma.appSetting.findUnique({
        where: { key: BILLING_PRICE_CATALOG_KEY },
        select: { updatedAt: true },
      });
      const currentUpdatedAt = currentPricing?.updatedAt.toISOString() || null;
      if (
        body.priceCatalogUpdatedAt !== undefined &&
        body.priceCatalogUpdatedAt !== currentUpdatedAt
      ) {
        return NextResponse.json(
          {
            error:
              "Localized prices were changed by another admin. Reload before saving.",
          },
          { status: 409 }
        );
      }
    }

    for (const plan of body.plans || []) {
      await prisma.billingPlan.upsert({
        where: { id: plan.id },
        create: {
          id: plan.id,
          name: planName(plan.id),
          tier: planName(plan.id),
          monthlyPriceCents: plan.monthlyPriceCents,
          annualPriceCents: plan.annualPriceCents,
          currency: "USD",
          stripeProductId: plan.stripeProductId,
          stripePriceId: plan.stripePriceId,
          stripeAnnualPriceId: plan.stripeAnnualPriceId,
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
          annualPriceCents: plan.annualPriceCents,
          stripeProductId: plan.stripeProductId,
          stripePriceId: plan.stripePriceId,
          stripeAnnualPriceId: plan.stripeAnnualPriceId,
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

    const savedPromotionIds: string[] = [];
    for (const promotion of body.promotions || []) {
      const id = promotionRecordId(promotion);
      savedPromotionIds.push(id);
      const existingPromotion = existingPromotionById.get(id) || null;
      const startsAt = promotion.startsAt ? new Date(promotion.startsAt) : null;
      const endsAt = promotion.endsAt ? new Date(promotion.endsAt) : null;
      const policyChanged =
        existingPromotion &&
        (existingPromotion.code !== promotion.code ||
          existingPromotion.discountPercent !== promotion.discountPercent ||
          existingPromotion.discountAmountCents !==
            (promotion.discountAmountCents || null) ||
          existingPromotion.maxRedemptions !==
            (promotion.maxRedemptions || null) ||
          existingPromotion.durationMonths !== promotion.durationMonths ||
          existingPromotion.fulfillmentType !== promotion.fulfillmentType ||
          existingPromotion.accessDurationDays !==
            (promotion.accessDurationDays || null) ||
          existingPromotion.appliesToPlanIds !==
            JSON.stringify(promotion.appliesToPlanIds) ||
          existingPromotion.startsAt?.toISOString() !==
            startsAt?.toISOString() ||
          existingPromotion.endsAt?.toISOString() !== endsAt?.toISOString() ||
          existingPromotion.allowAnnualStacking !==
            promotion.allowAnnualStacking);
      const stripeCouponId = policyChanged
        ? null
        : promotion.stripeCouponId;
      const stripePromotionCodeId = policyChanged
        ? null
        : promotion.stripePromotionCodeId;
      await prisma.billingPromotion.upsert({
        where: { id },
        create: {
          id,
          code: promotion.code,
          discountPercent: promotion.discountPercent,
          discountAmountCents: promotion.discountAmountCents || null,
          maxRedemptions: promotion.maxRedemptions || null,
          redeemedCount: promotion.redeemedCount || 0,
          durationMonths: promotion.durationMonths,
          fulfillmentType: promotion.fulfillmentType,
          accessDurationDays: promotion.accessDurationDays || null,
          appliesToPlanIds: JSON.stringify(promotion.appliesToPlanIds),
          stripeCouponId,
          stripePromotionCodeId,
          startsAt,
          endsAt,
          allowAnnualStacking: promotion.allowAnnualStacking,
          isActive: promotion.isActive,
        },
        update: {
          code: promotion.code,
          discountPercent: promotion.discountPercent,
          discountAmountCents: promotion.discountAmountCents || null,
          maxRedemptions: promotion.maxRedemptions || null,
          durationMonths: promotion.durationMonths,
          fulfillmentType: promotion.fulfillmentType,
          accessDurationDays: promotion.accessDurationDays || null,
          appliesToPlanIds: JSON.stringify(promotion.appliesToPlanIds),
          stripeCouponId,
          stripePromotionCodeId,
          startsAt,
          endsAt,
          allowAnnualStacking: promotion.allowAnnualStacking,
          isActive: promotion.isActive,
        },
      });
    }

    if (body.promotions) {
      await prisma.billingPromotion.deleteMany({
        where: { id: { notIn: savedPromotionIds } },
      });
    }

    if (body.settings?.guestDefaultModelId) {
      await updateGuestDefaultModel(body.settings.guestDefaultModelId);
    }
    if (body.priceCatalog) {
      await saveBillingPriceCatalog(body.priceCatalog);
    }

    await writeAdminAuditLog({
      session,
      request: req,
      action: "billing.updated",
      targetType: "BillingConfig",
      targetId: null,
      summary: "Updated billing plans, promotions, or billing-adjacent platform settings.",
      metadata: {
        plans: (body.plans || []).map((plan) => plan.id),
        promotions: (body.promotions || []).map((promotion) => promotion.code),
        guestDefaultModelId: body.settings?.guestDefaultModelId || null,
        localizedPricesUpdated: Boolean(body.priceCatalog),
      },
    });

    const [plans, promotions, settings, pricing] = await Promise.all([
      getBillingPlans(),
      getBillingPromotions(),
      getPublicAppSettings(),
      getBillingPriceCatalogWithMeta(),
    ]);
    return NextResponse.json({
      plans,
      promotions,
      settings,
      priceCatalog: pricing.catalog,
      priceCatalogUpdatedAt: pricing.updatedAt,
      priceCatalogSource: pricing.source,
    });
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
