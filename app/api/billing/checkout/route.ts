export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { randomUUID } from "node:crypto";
import type Stripe from "stripe";
import { z } from "zod";
import { authOptions } from "@/lib/auth";
import {
  ApiSecurityError,
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
  effectivePlanForAccess,
  isInternalPassPromotion,
} from "@/lib/foundingTesterPassCore";
import {
  ensureStripePromotionDiscount,
  StripePromotionProvisioningError,
} from "@/lib/stripePromotionProvisioning";
import {
  checkoutSessionIdempotencyKey,
  externalCheckoutError,
  isRetryableStripeError,
  stripeCustomerIdempotencyKey,
  stripeErrorFacts,
} from "@/lib/stripePromotionProvisioningCore";

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
    // One customer action. The client mints it when the purchase is submitted
    // and reuses it for network retries of *that* submission, which is what
    // lets the Stripe Session create carry an idempotency key without a
    // second click replaying a Session that has since expired.
    purchaseAttemptId: z.string().uuid().optional(),
  })
  .strict();

const activeSubscriptionStatuses = new Set(["active", "trialing", "past_due"]);

/**
 * Keying material for the idempotency keys sent to Stripe.
 *
 * The same deployment secret the promotion layer already hashes with, for the
 * same reason: Stripe stores and displays idempotency keys, so the account they
 * belong to must not be readable from them.
 */
const idempotencyKeySecret = () => {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) {
    throw new ApiSecurityError(
      503,
      "SECURITY_NOT_CONFIGURED",
      "Checkout security is not configured."
    );
  }
  return secret;
};

/**
 * Plan ordering, so "is this a new subscription, a change, or a downgrade" is
 * one comparison rather than a chain of plan-name conditionals.
 */
const PLAN_RANK: Record<"Free" | "Pro" | "Max", number> = {
  Free: 0,
  Pro: 1,
  Max: 2,
};

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

async function createCheckoutSession(
  params: Stripe.Checkout.SessionCreateParams,
  options?: Stripe.RequestOptions
) {
  return getStripe().checkout.sessions.create(params, options);
}

/**
 * Structured record of one failed checkout, keyed by a trace id the customer is
 * also given so support can join the two without the customer quoting anything
 * sensitive.
 *
 * What is deliberately absent: the Stripe secret, the Session URL, the
 * customer's email, the payment method, the raw client IP. The account appears
 * only as the opaque hash the promotion layer already uses.
 */
function logCheckoutFailure({
  traceId,
  stage,
  internalCode,
  retryable,
  planId,
  billingInterval,
  promotionId,
  promotionCode,
  details,
}: {
  traceId: string;
  stage: string;
  internalCode: string;
  retryable: boolean;
  planId: string;
  billingInterval: string;
  promotionId: string | null;
  promotionCode: string | null;
  details?: Record<string, unknown>;
}) {
  console.error("Stripe checkout failed.", {
    traceId,
    stage,
    internalCode,
    retryable,
    planId,
    billingInterval,
    promotionId,
    // The code string is operator-facing configuration, not customer data, and
    // it is the only way to find the promotion in the admin console.
    promotionCode,
    ...details,
  });
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
              name: `Tomverse Insight ${plan.name}`,
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
            name: `Tomverse Insight ${plan.name}`,
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
  // Minted before anything can fail, so every 5xx below can carry it and a
  // customer who reports "checkout is broken" hands support one string that
  // finds the exact request in the structured log.
  const traceId = randomUUID();
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json(
        { code: "AUTHENTICATION_REQUIRED", error: "Authentication required." },
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
      purchaseAttemptId: requestedPurchaseAttemptId,
    } = await readLimitedJson(req, 4 * 1024, checkoutSchema);
    // A client that predates this field, or one whose request was replayed
    // without it, still gets a valid key -- it just does not get retry
    // deduplication, which is strictly better than deduplicating two genuinely
    // separate purchase attempts into one Session.
    const purchaseAttemptId = requestedPurchaseAttemptId || randomUUID();
    const plans = await getBillingPlans();
    const plan = plans.find((item) => item.id === planId && item.isActive);
    if (!plan) {
      return NextResponse.json(
        {
          code: "CHECKOUT_CONFIGURATION_ERROR",
          error: "This plan is not ready for checkout yet.",
        },
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
        subscriptionCurrentPeriodEnd: true,
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
    // The plan the account can actually use right now, not the raw column: a
    // Founding Tester Pass that has run out still leaves `plan` at "Pro", and
    // blocking that account from subscribing would be wrong.
    const effectivePlan = effectivePlanForAccess({
      plan: user.plan,
      subscriptionStatus: user.subscriptionStatus,
      subscriptionCurrentPeriodEnd: user.subscriptionCurrentPeriodEnd,
    });
    const targetTier = tierForPlanId(planId as BillingPlanId);

    // Same plan. Previously this only failed if a Stripe subscription happened
    // to be attached, so an account holding a plan by any other route could
    // buy the plan it already had.
    if (effectivePlan === targetTier) {
      return NextResponse.json(
        {
          code: "PLAN_CHANGE_NOT_SUPPORTED",
          error: "This account is already on this plan.",
        },
        { status: 409 }
      );
    }

    // A downgrade. There is no in-product subscription-change flow -- only
    // cancel-at-period-end -- so creating a second, cheaper subscription here
    // would leave the account paying for two plans at once.
    if (PLAN_RANK[effectivePlan] > PLAN_RANK[targetTier]) {
      return NextResponse.json(
        {
          code: "PLAN_CHANGE_NOT_SUPPORTED",
          error:
            "Moving to a lower plan is handled from account settings at the end of the paid period.",
        },
        { status: 409 }
      );
    }

    // An upgrade while a Stripe subscription is live is a *change* to that
    // subscription, which this product does not implement. The UI must not
    // offer a checkout CTA here (see resolvePlanCtaState in
    // lib/purchaseIntent.ts, which resolves this state to "manage_plan"); the
    // code lets the client say so precisely if it ever gets here anyway.
    if (
      user.stripeSubscriptionId &&
      user.subscriptionStatus &&
      activeSubscriptionStatuses.has(user.subscriptionStatus)
    ) {
      return NextResponse.json(
        {
          code: "ACTIVE_SUBSCRIPTION_EXISTS",
          error: "An active subscription already exists.",
        },
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
    const idempotencySecret = idempotencyKeySecret();
    let stripeCustomerId = user.stripeCustomerId;
    if (!stripeCustomerId) {
      // Keyed per account, because two checkout attempts that both start before
      // the first one writes `stripeCustomerId` back would otherwise create two
      // customers -- and the subscription then lands on the one the account is
      // not pointing at.
      const customer = await stripe.customers.create(
        {
          email: user.email || undefined,
          name: user.name || undefined,
          metadata: { userId: user.id },
        },
        {
          idempotencyKey: stripeCustomerIdempotencyKey({
            userId: user.id,
            secret: idempotencySecret,
          }),
        }
      );
      stripeCustomerId = customer.id;
      // Conditional, so the loser of that race does not overwrite the id the
      // winner already stored.
      await prisma.user.updateMany({
        where: { id: user.id, stripeCustomerId: null },
        data: { stripeCustomerId },
      });
      const stored = await prisma.user.findUnique({
        where: { id: user.id },
        select: { stripeCustomerId: true },
      });
      stripeCustomerId = stored?.stripeCustomerId || stripeCustomerId;
    }

    let promotionLeaseReserved = false;
    if (appliedPromotion) {
      await reservePromotionCheckout(appliedPromotion.id, user.id);
      promotionLeaseReserved = true;
    }
    // Hoisted so the failure log can say whether a discount had been resolved
    // by the time the Session create was attempted -- that one bit separates
    // "the promotion could not be provisioned" from "the promotion was fine and
    // the Session itself was refused".
    let discountApplied = false;
    try {
      const discountResult = appliedPromotion
        ? await ensureStripePromotionDiscount({
            promotion: appliedPromotion,
            planId: planId as BillingPlanId,
            planProductId: plan.stripeProductId,
            customerId: stripeCustomerId,
          })
        : null;
      if (discountResult?.driftReasons.length) {
        // Not fatal: Stripe and the database disagree about a cap that has not
        // denied anyone anything yet. Reported so it is fixed before it does.
        console.warn("Stripe promotion linkage drift.", {
          traceId,
          promotionId: appliedPromotion?.id || null,
          promotionCode: appliedPromotion?.code || null,
          resolution: discountResult.resolution,
          driftReasons: discountResult.driftReasons,
        });
      }
      const discount = discountResult?.discount || null;
      discountApplied = Boolean(discount);
      const promotionMetadata: Record<string, string> = {};
      if (appliedPromotion) {
        promotionMetadata.promotionId = appliedPromotion.id;
        promotionMetadata.promotionIpHash = promotionClientIpHash || "";
        promotionMetadata.promotionRiskFlags =
          encodePromotionRiskFlags(promotionRiskFlags);
      }
      const checkoutSession = await createCheckoutSession(
        {
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
          // Cancelling used to drop the visitor on a bare /pricing with no
          // acknowledgement and no way back to the plan they were considering.
          cancel_url: `${origin}/pricing?billing=cancelled&plan=${encodeURIComponent(
            planId
          )}${language ? `&lang=${encodeURIComponent(language)}` : ""}#plans`,
          expires_at: appliedPromotion
            ? Math.floor(Date.now() / 1000) + PROMOTION_CHECKOUT_TTL_SECONDS
            : undefined,
          client_reference_id: user.id,
          // Stripe rejects a Session that carries both `allow_promotion_codes`
          // and `discounts` -- it checks that the parameters are *present*, not
          // what they are set to, so sending `false` alongside a discount is the
          // same 400 as sending `true`. That is what broke every promotion
          // checkout: the discount was applied correctly and the Session was then
          // refused, surfacing as a generic 500.
          //
          // Omitting the field is not a relaxation. Stripe's own default is
          // false, and a Session that pins a server-validated discount cannot
          // show the code entry box regardless: the two are mutually exclusive.
          // Every path that does *not* carry a discount still says so
          // explicitly, so the Stripe-side code box is never reachable from a
          // Tomverse checkout.
          ...(discount
            ? { discounts: [discount] }
            : { allow_promotion_codes: false }),
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
        },
        {
          idempotencyKey: checkoutSessionIdempotencyKey({
            userId: user.id,
            purchaseAttemptId,
            secret: idempotencySecret,
          }),
        }
      );

      return NextResponse.json({ url: checkoutSession.url });
    } catch (error) {
      if (promotionLeaseReserved && appliedPromotion) {
        // Released on *every* failure below this point, not just a Stripe one:
        // a lease that outlives the attempt that took it locks the customer out
        // of retrying for its full 31-minute TTL for no reason. A release that
        // itself fails is reported rather than swallowed, because the lock is
        // then real and only time will clear it.
        await releasePromotionCheckout(appliedPromotion.id, user.id).catch(
          (releaseError) => {
            console.error("Promotion checkout lease release failed.", {
              traceId,
              promotionId: appliedPromotion.id,
              promotionCode: appliedPromotion.code,
              errorName:
                releaseError instanceof Error
                  ? releaseError.name
                  : "UnknownError",
            });
          }
        );
      }
      if (error instanceof StripePromotionProvisioningError) {
        logCheckoutFailure({
          traceId,
          stage: error.stage,
          internalCode: error.code,
          retryable: error.retryable,
          planId,
          billingInterval,
          promotionId: appliedPromotion?.id || null,
          promotionCode: appliedPromotion?.code || null,
          details: error.details,
        });
        const external = externalCheckoutError(error.code);
        return NextResponse.json(
          { code: external.code, error: external.error, traceId },
          { status: external.status }
        );
      }
      // Everything left is the Session create itself. A provider outage and a
      // request Stripe will refuse identically forever are different answers:
      // one is worth retrying, the other needs an operator.
      const facts = stripeErrorFacts(error);
      const retryable = isRetryableStripeError(facts);
      const internalCode = retryable
        ? "CHECKOUT_PROVIDER_UNAVAILABLE"
        : "CHECKOUT_SESSION_CREATE_FAILED";
      logCheckoutFailure({
        traceId,
        stage: "session",
        internalCode,
        retryable,
        planId,
        billingInterval,
        promotionId: appliedPromotion?.id || null,
        promotionCode: appliedPromotion?.code || null,
        details: {
          stripeErrorType: facts.type,
          stripeErrorCode: facts.code,
          stripeErrorParam: facts.param,
          stripeRequestId: facts.requestId,
          discountApplied,
        },
      });
      const external = externalCheckoutError(internalCode);
      return NextResponse.json(
        { code: external.code, error: external.error, traceId },
        { status: external.status }
      );
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
        {
          code: "PROMOTION_REDEMPTION_LIMIT_REACHED",
          error: "This promotion code has reached its redemption limit.",
        },
        { status: 409 }
      );
    }
    // Anything that got here failed before the Stripe calls -- plan lookup,
    // promotion validation, the analytics snapshot, the internal pass path.
    // Logged with the same trace id the customer is handed.
    logCheckoutFailure({
      traceId,
      stage: "request",
      internalCode: "CHECKOUT_SESSION_CREATE_FAILED",
      retryable: false,
      planId: "unknown",
      billingInterval: "unknown",
      promotionId: null,
      promotionCode: null,
      details: {
        errorName: error instanceof Error ? error.name : "UnknownError",
      },
    });
    return NextResponse.json(
      {
        code: "CHECKOUT_CONFIGURATION_ERROR",
        error: "Failed to start checkout.",
        traceId,
      },
      { status: 500 }
    );
  }
}
