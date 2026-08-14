import "server-only";

import {
  getBillingPlans,
  type BillingPlanId,
  type BillingPromotionConfig,
} from "@/lib/billingConfig";
import {
  getPlanPriceMinor,
  readBillingPriceCatalog,
} from "@/lib/billingPriceCatalog";
import type { BillingCurrency } from "@/lib/billingMarkets";
import { parsePromotionRiskFlags } from "@/lib/billingPromotionSecurity";
import { effectivePlanForAccess } from "@/lib/foundingTesterPassCore";
import { prisma } from "@/lib/prisma";
import {
  buildCheckoutRequestPreview,
  collectReasonSlugs,
  evaluateAccountEligibility,
  evaluateLocalPolicy,
  evaluateStripeLinkage,
  recommendActions,
  summarizeDiagnostics,
  type DiagnosticsAccount,
  type DiagnosticsInterval,
  type DiagnosticsPlanId,
  type PromotionDiagnosticsReport,
  type StripeLinkageFacts,
} from "@/lib/promotionDiagnosticsCore";
import { isStripeConfigured } from "@/lib/stripe";
import { inspectStripePromotionLinkage } from "@/lib/stripePromotionProvisioning";

/**
 * Runs the Admin promotion diagnostics. Reads only.
 *
 * The whole value of this module is what it does *not* call. It never reaches
 * `ensureStripePromotionDiscount()` -- that function creates a Coupon, creates
 * a Promotion Code and rewrites the row's Stripe linkage, all of which are
 * reasonable during a real checkout and none of which an operator asked for by
 * pressing "Run diagnostics". It never reserves or releases a promotion
 * checkout lease, so running it does not lock the customer out of retrying for
 * the lease's 31 minutes. It never creates a Stripe Customer or a Checkout
 * Session, never increments `redeemedCount`, and never writes a redemption.
 *
 * It also never calls `validatePromotionForCheckout()`, even though that is the
 * function Checkout uses, because that function hashes the *request's* client
 * IP into the promotion abuse signal. From an Admin route the request is the
 * operator's, and feeding a support session into the shared-IP heuristic would
 * corrupt the very signal the console exists to read. The policy predicate is
 * called directly instead, and the abuse layer is reported as not evaluated.
 *
 * The only side effect anywhere in this feature is the audit entry the route
 * writes, which is a record of the read, not a change to what was read.
 */

export type PromotionDiagnosticsInput = {
  promotionId?: string;
  code?: string;
  planId: DiagnosticsPlanId;
  billingInterval: DiagnosticsInterval;
  currency?: BillingCurrency;
  userId?: string | null;
  now?: Date;
};

export type PromotionDiagnosticsOutcome =
  | { ok: false; code: "PROMOTION_NOT_FOUND" }
  | {
      ok: true;
      promotion: {
        id: string;
        code: string;
        fulfillmentType: BillingPromotionConfig["fulfillmentType"];
        appliesToPlanIds: BillingPlanId[];
        discountPercent: number;
        discountAmountCents: number | null;
        durationMonths: number;
        maxRedemptions: number | null;
        redeemedCount: number;
        startsAt: string | null;
        endsAt: string | null;
        allowAnnualStacking: boolean;
        isActive: boolean;
        /** Admin-only. Masked for display by the panel. */
        stripeCouponId: string | null;
        stripePromotionCodeId: string | null;
      };
      planId: DiagnosticsPlanId;
      billingInterval: DiagnosticsInterval;
      currency: BillingCurrency;
      accountSelected: boolean;
      report: PromotionDiagnosticsReport;
    };

const loadPromotion = async (input: PromotionDiagnosticsInput) => {
  if (input.promotionId) {
    return prisma.billingPromotion.findUnique({
      where: { id: input.promotionId },
    });
  }
  if (input.code) {
    return prisma.billingPromotion.findUnique({
      where: { code: input.code.trim().toUpperCase() },
    });
  }
  return null;
};

const parsePlanIds = (value: string): BillingPlanId[] => {
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is BillingPlanId =>
        item === "free" || item === "pro" || item === "max"
    );
  } catch {
    return [];
  }
};

/**
 * Aggregated abuse signal counts.
 *
 * Counts only. The raw client IP hash and the payment-method fingerprint hash
 * are stored per redemption and neither is returned: they identify a person
 * across accounts, which is precisely why they are hashed in the first place,
 * and an operator cannot act on either one.
 */
const loadRiskSignals = async (promotionId: string) => {
  const rows = await prisma.billingPromotionRedemption.groupBy({
    by: ["riskFlags"],
    where: { promotionId, riskFlags: { not: "[]" } },
    _count: { _all: true },
  });
  const signals = { total: 0, sharedIp: 0, sharedPaymentMethod: 0 };
  for (const row of rows) {
    const flags = parsePromotionRiskFlags(row.riskFlags);
    signals.total += row._count._all;
    if (flags.includes("shared_ip")) signals.sharedIp += row._count._all;
    if (flags.includes("shared_payment_method")) {
      signals.sharedPaymentMethod += row._count._all;
    }
  }
  return signals;
};

const loadAccount = async (
  userId: string,
  promotionId: string
): Promise<DiagnosticsAccount> => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      plan: true,
      stripeSubscriptionId: true,
      subscriptionStatus: true,
      subscriptionCurrentPeriodEnd: true,
    },
  });
  if (!user) {
    return {
      exists: false,
      effectivePlan: "Free",
      storedPlan: "Free",
      hasStripeSubscription: false,
      subscriptionStatus: null,
      alreadyRedeemed: false,
    };
  }
  const redemption = await prisma.billingPromotionRedemption.findUnique({
    where: { promotionId_userId: { promotionId, userId } },
    select: { id: true },
  });
  const storedPlan =
    user.plan === "Max" ? "Max" : user.plan === "Pro" ? "Pro" : "Free";
  return {
    exists: true,
    // The plan the account can actually use right now: a lapsed Founding Tester
    // Pass leaves `plan` at "Pro", and judging against the raw column would
    // report a checkout as blocked that the server would accept.
    effectivePlan: effectivePlanForAccess({
      plan: user.plan,
      subscriptionStatus: user.subscriptionStatus,
      subscriptionCurrentPeriodEnd: user.subscriptionCurrentPeriodEnd,
    }),
    storedPlan,
    hasStripeSubscription: Boolean(user.stripeSubscriptionId),
    subscriptionStatus: user.subscriptionStatus,
    alreadyRedeemed: Boolean(redemption),
  };
};

export async function runPromotionDiagnostics(
  input: PromotionDiagnosticsInput
): Promise<PromotionDiagnosticsOutcome> {
  const row = await loadPromotion(input);
  if (!row) return { ok: false, code: "PROMOTION_NOT_FOUND" };

  const now = input.now || new Date();
  const currency: BillingCurrency = input.currency || "USD";
  const fulfillmentType =
    row.fulfillmentType === "internal_pass"
      ? ("internal_pass" as const)
      : ("stripe_subscription" as const);
  const promotion = {
    id: row.id,
    code: row.code,
    discountPercent: row.discountPercent,
    discountAmountCents: row.discountAmountCents,
    durationMonths: row.durationMonths,
    maxRedemptions: row.maxRedemptions,
    endsAt: row.endsAt?.toISOString() || null,
    startsAt: row.startsAt?.toISOString() || null,
    isActive: row.isActive,
    redeemedCount: row.redeemedCount,
    appliesToPlanIds: parsePlanIds(row.appliesToPlanIds),
    allowAnnualStacking: row.allowAnnualStacking,
    fulfillmentType,
    accessDurationDays: row.accessDurationDays,
    stripeCouponId: row.stripeCouponId,
    stripePromotionCodeId: row.stripePromotionCodeId,
  };

  const [plans, priceCatalog, riskSignals] = await Promise.all([
    getBillingPlans(),
    readBillingPriceCatalog(),
    loadRiskSignals(promotion.id),
  ]);
  const plan = plans.find((item) => item.id === input.planId) || null;
  const baseAmountMinor = plan
    ? getPlanPriceMinor(plan, currency, input.billingInterval, priceCatalog)
    : 0;

  const localPolicy = evaluateLocalPolicy({
    promotion,
    planId: input.planId,
    billingInterval: input.billingInterval,
    now,
  });

  const account = evaluateAccountEligibility({
    account: input.userId
      ? await loadAccount(input.userId, promotion.id)
      : null,
    planId: input.planId,
  });

  let stripeFacts: StripeLinkageFacts | null = null;
  const stripeConfigured = isStripeConfigured();
  if (stripeConfigured && fulfillmentType !== "internal_pass") {
    // Read-only. `inspectStripePromotionLinkage` retrieves and lists; it has no
    // create, update or delete path, and it is the same evaluation the checkout
    // provisioner runs, so the console and the customer see one verdict.
    const linkage = await inspectStripePromotionLinkage({
      promotion: {
        ...promotion,
        updatedAt: row.updatedAt.toISOString(),
      } as BillingPromotionConfig,
      planId: input.planId as BillingPlanId,
      planProductId: plan?.stripeProductId || null,
      now,
    });
    stripeFacts = {
      expectLiveMode: linkage.expectLiveMode,
      storedCouponId: linkage.storedCouponId,
      storedPromotionCodeId: linkage.storedPromotionCodeId,
      storedPromotionCodeExists: linkage.storedPromotionCodeExists,
      storedPromotionCodeMismatches: linkage.storedPromotionCodeMismatches,
      exactCodeCandidates: linkage.exactCodeCandidates,
      recommendation: linkage.recommendation,
    };
  }

  const stripe = evaluateStripeLinkage({
    stripeConfigured,
    facts: stripeFacts,
    internalPass: fulfillmentType === "internal_pass",
  });

  const checkoutPreview = buildCheckoutRequestPreview({
    promotion,
    currency,
    baseAmountMinor,
    discountResolvable:
      fulfillmentType !== "internal_pass" &&
      stripe.status !== "fail" &&
      stripe.status !== "not_checked",
  });

  const sections = { localPolicy, account, stripe, checkoutPreview };

  return {
    ok: true,
    promotion: {
      id: promotion.id,
      code: promotion.code,
      fulfillmentType,
      appliesToPlanIds: promotion.appliesToPlanIds,
      discountPercent: promotion.discountPercent,
      discountAmountCents: promotion.discountAmountCents,
      durationMonths: promotion.durationMonths,
      maxRedemptions: promotion.maxRedemptions,
      redeemedCount: promotion.redeemedCount,
      startsAt: promotion.startsAt,
      endsAt: promotion.endsAt,
      allowAnnualStacking: promotion.allowAnnualStacking,
      isActive: promotion.isActive,
      stripeCouponId: promotion.stripeCouponId,
      stripePromotionCodeId: promotion.stripePromotionCodeId,
    },
    planId: input.planId,
    billingInterval: input.billingInterval,
    currency,
    accountSelected: Boolean(input.userId),
    report: {
      status: summarizeDiagnostics(sections),
      localPolicy,
      account,
      stripe,
      checkoutPreview,
      abuseSignals: {
        evaluated: false,
        reason: "admin_request_ip_is_not_the_customer_ip",
        storedRiskSignals: riskSignals,
      },
      recommendedActions: recommendActions(sections),
      reasonSlugs: collectReasonSlugs(sections),
    },
  };
}
