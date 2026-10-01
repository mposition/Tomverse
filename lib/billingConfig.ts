import "server-only";

import type {
  BillingPlan as PrismaBillingPlan,
  BillingPromotion as PrismaBillingPromotion,
} from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { ModelTier } from "@/lib/models";
import {
  getDefaultBillingPlan,
  getDefaultBillingPlans,
  type BillingPlanConfig,
  type BillingPlanId,
} from "@/lib/billingPlanDefaults";
import { promotionEligibilityFailure } from "@/lib/billingPromotionCore";
import { getPublicCreditPackCatalog } from "@/lib/creditPacks";

// The plan shape and its built-in values live in lib/billingPlanDefaults.ts so
// the marketing surface can reach them without importing this `server-only`
// module. Re-exported here so every existing server import keeps working.
export {
  getDefaultBillingPlans,
  getDefaultBillingPlan,
} from "@/lib/billingPlanDefaults";
export type {
  BillingPlanConfig,
  BillingPlanId,
} from "@/lib/billingPlanDefaults";

export type BillingPromotionConfig = {
  id: string;
  code: string;
  discountPercent: number;
  discountAmountCents: number | null;
  maxRedemptions: number | null;
  redeemedCount: number;
  durationMonths: number;
  fulfillmentType: "stripe_subscription" | "internal_pass";
  accessDurationDays: number | null;
  appliesToPlanIds: BillingPlanId[];
  stripeCouponId: string | null;
  stripePromotionCodeId: string | null;
  startsAt: string | null;
  endsAt: string | null;
  allowAnnualStacking: boolean;
  isActive: boolean;
  updatedAt?: string | null;
};

const normalizePlanId = (value: string): BillingPlanId | null =>
  value === "free" || value === "pro" || value === "max" ? value : null;

export const planIdForTier = (tier: ModelTier): BillingPlanId =>
  tier === "Max" ? "max" : tier === "Pro" ? "pro" : "free";

export const tierForPlanId = (planId: BillingPlanId): ModelTier =>
  planId === "max" ? "Max" : planId === "pro" ? "Pro" : "Free";

const parsePlanIds = (value: string): BillingPlanId[] => {
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => (typeof item === "string" ? normalizePlanId(item) : null))
      .filter((item): item is BillingPlanId => Boolean(item));
  } catch {
    return [];
  }
};

/**
 * The marker the admin save path leaves on a row an administrator submitted.
 *
 * A `BillingPlan` row is not evidence that anybody chose its numbers.
 * `syncBillingDefaultsToDatabase()` copies the compiled defaults into rows, and
 * it runs whenever the admin billing screen renders
 * (`app/(site)/(application)/admin/billing/page.tsx`) or its API is called --
 * so on a deployment where nobody has ever pressed save, every plan has a row
 * and every number in it came from the code.
 *
 * **Positive, not negative.** Marking the seeder's rows instead would answer
 * the question only for rows written after the marker existed: every row
 * already in production carries `metadata = NULL`, was written by the seeder,
 * and would read as an administrator's decision. The absence of evidence is not
 * evidence, so the rule is that a row is a decision when it says so, and
 * anything else -- a legacy row, a row written by something that did not know
 * about this, a row whose metadata was cleared -- is a compiled default.
 */
export const BILLING_PLAN_ADMIN_SAVED = "admin_saved";

// `Object.hasOwn`: Prisma hands back a plain object, so without it a
// `provenance` on `Object.prototype` would make every row -- including the
// seeder's and every legacy one -- read as an administrator's decision, which
// is the whole of what this function is asked.
const isAdminSavedRow = (metadata: unknown): boolean =>
  !!metadata &&
  typeof metadata === "object" &&
  !Array.isArray(metadata) &&
  Object.hasOwn(metadata, "provenance") &&
  (metadata as Record<string, unknown>).provenance === BILLING_PLAN_ADMIN_SAVED;

/**
 * The compiled defaults with the stored rows laid over them.
 *
 * Extracted so the two readers work from one `findMany` result each rather than
 * from two independent queries. Two queries can straddle an admin save, and the
 * reader would then describe one snapshot's sources beside another snapshot's
 * numbers -- reporting a derived annual price as stored, which is the single
 * mistake this reader exists to prevent.
 */
const mergeBillingPlanRows = (
  rows: readonly PrismaBillingPlan[],
): BillingPlanConfig[] => {
  const merged = new Map<BillingPlanId, BillingPlanConfig>(
    getDefaultBillingPlans().map((plan) => [plan.id, plan])
  );

  for (const row of rows) {
    const id = normalizePlanId(row.id);
    if (!id) continue;
    merged.set(id, {
      id,
      name: row.name,
      tier: tierForPlanId(id),
      monthlyPriceCents: row.monthlyPriceCents,
      annualPriceCents:
        row.annualPriceCents ?? Math.round(row.monthlyPriceCents * 12 * 0.8),
      currency: row.currency,
      stripeProductId: row.stripeProductId,
      stripePriceId: row.stripePriceId,
      stripeAnnualPriceId: row.stripeAnnualPriceId,
      dailyMessageLimit: row.dailyMessageLimit,
      monthlyMessageLimit: row.monthlyMessageLimit,
      maxModels: row.maxModels,
      allowAttachments: row.allowAttachments,
      allowSharing: row.allowSharing,
      allowDownloads: row.allowDownloads,
      isActive: row.isActive,
      sortOrder: row.sortOrder,
      updatedAt: row.updatedAt.toISOString(),
    });
  }

  return Array.from(merged.values()).sort((a, b) => a.sortOrder - b.sortOrder);
};

export async function getBillingPlans(): Promise<BillingPlanConfig[]> {
  const rows = await prisma.billingPlan.findMany({
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
  });
  return mergeBillingPlanRows(rows);
}

/**
 * Where each plan field's value came from.
 *
 * docs/policy/marketing-automation.md §7.2: a price or plan claim may only rest
 * on a stored value. The distinction is invisible in `getBillingPlans()`, which
 * merges three sources into one number on purpose -- that is what a caller
 * serving a page wants. A claim needs the opposite: a number that is the
 * compiled default is a number nobody chose for this deployment, and a derived
 * one is arithmetic rather than a decision, so neither can back a public
 * statement about what we charge.
 *
 * `derived_formula` exists because of two fields. `annualPriceCents` is
 * `monthly * 12 * 0.8` when the row leaves it NULL, and once merged the result
 * is indistinguishable from a price somebody set; `tier` is computed from the
 * plan id and the stored column is never read.
 *
 * There are three values and no more, because docs/policy/marketing-automation.md §7.2
 * names three. A row the seeder wrote, a row from before this marker existed,
 * and no row at all are all `compiled_default`: they differ in how the number
 * got there and not in the only thing the claim depends on, which is that
 * nobody in this deployment chose it.
 *
 * What `stored` claims, precisely: this row was written by the admin save path.
 * The billing panel submits every plan on each save, so it means an
 * administrator submitted this row's values, not that they altered this
 * particular field. That is the strongest claim the table can support, and a
 * claim resting on it is `approval_required` anyway.
 */
export type BillingPlanFieldSource =
  | "stored"
  | "compiled_default"
  | "derived_formula";

export type BillingPlanWithFieldSources = {
  plan: BillingPlanConfig;
  /** One entry per field of the merged plan. */
  sources: Record<keyof BillingPlanConfig, BillingPlanFieldSource>;
};

/**
 * The same plans `getBillingPlans()` returns, each with where its fields came
 * from.
 *
 * A separate reader rather than a second field on the existing one: every
 * current caller wants the merged answer, and adding a field they would all
 * have to ignore is how a reader acquires two audiences. The test pins that the
 * plans this returns are identical to the existing reader's, so the two cannot
 * drift into disagreeing about the values while agreeing about their sources.
 */
export async function getBillingPlansWithFieldSources(): Promise<
  BillingPlanWithFieldSources[]
> {
  // One read, and the plans are merged from it rather than fetched again: see
  // `mergeBillingPlanRows`.
  const rows = await prisma.billingPlan.findMany({
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
  });
  const plans = mergeBillingPlanRows(rows);

  const rowById = new Map<BillingPlanId, PrismaBillingPlan>();
  for (const row of rows) {
    const id = normalizePlanId(row.id);
    if (id) rowById.set(id, row);
  }

  return plans.map((plan) => {
    const row = rowById.get(plan.id);
    const adminSaved = !!row && isAdminSavedRow(row.metadata);
    const annualIsDerived = !!row && row.annualPriceCents === null;

    const sourceOf = (field: keyof BillingPlanConfig): BillingPlanFieldSource => {
      // Derived first: an annual price the code computed is arithmetic whoever
      // wrote the row, and `compiled_default` would name the wrong reason.
      if (field === "annualPriceCents" && annualIsDerived) {
        return "derived_formula";
      }
      // `getBillingPlans()` computes this from the id with `tierForPlanId()`
      // and never reads the column, so the stored value is not what a caller
      // is looking at.
      if (field === "tier") return "derived_formula";
      return adminSaved ? "stored" : "compiled_default";
    };

    const sources = Object.fromEntries(
      (Object.keys(plan) as (keyof BillingPlanConfig)[]).map((field) => [
        field,
        sourceOf(field),
      ]),
    ) as Record<keyof BillingPlanConfig, BillingPlanFieldSource>;

    return { plan, sources };
  });
}

export async function syncBillingDefaultsToDatabase() {
  const existingPlans = await prisma.billingPlan.findMany({
    select: { id: true },
  });
  const existingPlanIds = new Set(existingPlans.map((plan) => plan.id));

  for (const plan of getDefaultBillingPlans()) {
    if (existingPlanIds.has(plan.id)) continue;
    await prisma.billingPlan.create({
      data: {
        // No provenance marker: this row is the compiled defaults, and the
        // reader treats an unmarked row as exactly that. The marker is written
        // by the admin save path, which is the only thing that makes a row a
        // decision.
        id: plan.id,
        name: plan.name,
        tier: plan.tier,
        monthlyPriceCents: plan.monthlyPriceCents,
        annualPriceCents: plan.annualPriceCents,
        currency: plan.currency,
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
        sortOrder: plan.sortOrder,
      },
    });
  }

}

export async function getBillingPlanByTier(tier: ModelTier) {
  const plans = await getBillingPlans();
  return (
    plans.find((plan) => plan.id === planIdForTier(tier)) ||
    getDefaultBillingPlan("free")
  );
}

export async function getBillingPromotions(): Promise<BillingPromotionConfig[]> {
  const rows = await prisma.billingPromotion.findMany({
    orderBy: [{ isActive: "desc" }, { code: "asc" }],
  });
  return rows.map(toBillingPromotionConfig);
}

const toBillingPromotionConfig = (
  row: PrismaBillingPromotion
): BillingPromotionConfig => ({
    id: row.id,
    code: row.code,
    discountPercent: row.discountPercent,
    discountAmountCents: row.discountAmountCents,
    maxRedemptions: row.maxRedemptions,
    redeemedCount: row.redeemedCount,
    durationMonths: row.durationMonths,
    fulfillmentType:
      row.fulfillmentType === "internal_pass"
        ? "internal_pass"
        : "stripe_subscription",
    accessDurationDays: row.accessDurationDays,
    appliesToPlanIds: parsePlanIds(row.appliesToPlanIds),
    stripeCouponId: row.stripeCouponId,
    stripePromotionCodeId: row.stripePromotionCodeId,
    startsAt: row.startsAt?.toISOString() || null,
    endsAt: row.endsAt?.toISOString() || null,
    allowAnnualStacking: row.allowAnnualStacking,
    isActive: row.isActive,
    updatedAt: row.updatedAt.toISOString(),
  });

export async function getBillingPromotionByCode(code: string) {
  const row = await prisma.billingPromotion.findUnique({ where: { code } });
  return row ? toBillingPromotionConfig(row) : null;
}

export function isBillingPromotionRedeemable(
  promotion: BillingPromotionConfig,
  now = new Date()
) {
  return promotionEligibilityFailure({ promotion, now }) === null;
}

export async function getPublicBillingConfig() {
  const [plans, featuredPromotion] = await Promise.all([
    getBillingPlans(),
    getBillingPromotionByCode("TOMVERSE50"),
  ]);
  const publicFeaturedPromotion =
    featuredPromotion && isBillingPromotionRedeemable(featuredPromotion)
      ? {
          code: featuredPromotion.code,
          discountPercent: featuredPromotion.discountPercent,
          discountAmountCents: featuredPromotion.discountAmountCents,
          durationMonths: featuredPromotion.durationMonths,
          appliesToPlanIds: featuredPromotion.appliesToPlanIds,
          billingIntervals: featuredPromotion.allowAnnualStacking
            ? (["monthly", "annual"] as const)
            : (["monthly"] as const),
          endsAt: featuredPromotion.endsAt,
        }
      : null;
  return {
    plans: plans.filter((plan) => plan.isActive),
    creditPacks: getPublicCreditPackCatalog(),
    featuredPromotion: publicFeaturedPromotion,
    promotionPolicy: {
      codesListed: false as const,
      validation: "server_only" as const,
      annualDiscountStacking: "promotion_specific_default_denied" as const,
    },
  };
}
