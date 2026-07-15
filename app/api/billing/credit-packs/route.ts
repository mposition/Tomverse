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
import { getCreditPack, getCreditPacksForPlan } from "@/lib/creditPacks";
import { prisma } from "@/lib/prisma";
import { getPublicAppOrigin } from "@/lib/publicUrl";
import { getStripe } from "@/lib/stripe";
import type { ModelTier } from "@/lib/models";
import {
  analyticsAttributionSchema,
  purchaseAnalyticsTriggerSchema,
} from "@/lib/productAnalyticsShared";
import {
  getPurchaseAnalyticsSnapshot,
  purchaseAnalyticsMetadata,
} from "@/lib/purchaseAnalytics";
import {
  BillingMarketValidationError,
  inferBillingMarketFromRequest,
  validateBillingMarketRequest,
} from "@/lib/billingCurrency";
import {
  getBillingPriceCatalog,
  getCreditPackPriceMinor,
  getUsdRevenueSnapshot,
} from "@/lib/billingPriceCatalog";
import {
  BILLING_CURRENCIES,
  billingMinorToMajor,
  type BillingCurrency,
} from "@/lib/billingMarkets";
import { checkoutBillingMetadata } from "@/lib/billingTransactions";

const inputSchema = z
  .object({
    packId: z.string().max(32),
    language: z.enum(["ko", "en", "zh", "fr", "de", "es", "pt"]).optional(),
    analytics: analyticsAttributionSchema.optional(),
    trigger: purchaseAnalyticsTriggerSchema.default("proactive"),
    currency: z.enum(BILLING_CURRENCIES).optional(),
    country: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/).optional(),
  })
  .strict();
const normalizePlan = (value: unknown): ModelTier =>
  value === "Pro" || value === "Max" ? value : "Free";

const publicPack = (
  pack: NonNullable<ReturnType<typeof getCreditPack>>,
  priceMinor: number,
  currency: BillingCurrency
) => ({
  id: pack.id,
  name: pack.name,
  credits: pack.credits,
  priceMinor,
  priceCents: priceMinor,
  currency,
  validityDays: pack.validityDays,
});

export async function GET(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Authentication required." }, { status: 401 });
    }
    await consumeApiRateLimit(req, session.user.id, "credit-packs-read", {
      minute: 60,
      day: 2_000,
    });
    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: {
        plan: true,
        creditDebtCredits: true,
        creditDebtCostMicroUsd: true,
        billingRiskStatus: true,
      },
    });
    if (!user) return NextResponse.json({ error: "User not found." }, { status: 404 });
    const plan = normalizePlan(user.plan);
    const market = inferBillingMarketFromRequest(req);
    const catalog = await getBillingPriceCatalog();
    const snapshot = await getPurchaseAnalyticsSnapshot({
      userId: session.user.id,
      currentPlan: plan,
      creditDebtCredits: user.creditDebtCredits,
    });
    const balance = snapshot.purchasedBalance;
    return NextResponse.json({
      plan,
      analyticsContext: snapshot.context,
      market,
      packs: getCreditPacksForPlan(plan).map((pack) =>
        publicPack(
          pack,
          getCreditPackPriceMinor(pack.id, market.currency, catalog),
          market.currency
        )
      ),
      balance: {
        ...balance,
        earliestExpiry: balance.earliestExpiry?.toISOString() || null,
      },
      creditDebt: {
        credits: user.creditDebtCredits,
        fundedCostMicroUsd: Number(user.creditDebtCostMicroUsd),
        riskStatus: user.billingRiskStatus,
      },
      notice:
        "Additional credits increase usage only. Your current plan's model access, features, daily limits, and fair-use safeguards do not change.",
    });
  } catch (error) {
    const response = apiSecurityResponse(error);
    if (response) return response;
    console.error("Failed to load credit packs:", error);
    return NextResponse.json({ error: "Failed to load credit packs." }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Authentication required." }, { status: 401 });
    }
    await consumeApiRateLimit(req, session.user.id, "credit-pack-checkout", {
      minute: 5,
      day: 20,
    });
    const { packId, language, analytics, trigger, currency, country } = await readLimitedJson(
      req,
      4 * 1024,
      inputSchema
    );
    const pack = getCreditPack(packId);
    if (!pack) return NextResponse.json({ error: "Credit pack not found." }, { status: 404 });
    const market = validateBillingMarketRequest({ req, currency, country });
    const catalog = await getBillingPriceCatalog();
    const priceMinor = getCreditPackPriceMinor(pack.id, market.currency, catalog);
    const usdRevenueSnapshot = await getUsdRevenueSnapshot({
      amountMinor: priceMinor,
      currency: market.currency,
      fallbackUsdMinor: pack.priceCents,
    });
    const billingMetadata = checkoutBillingMetadata({
      currency: market.currency,
      country: market.country,
      expectedAmountMinor: priceMinor,
      amountUsdMicroUsd: usdRevenueSnapshot.amountUsdMicroUsd,
      usdConversionRate: usdRevenueSnapshot.usdConversionRate,
      usdConversionSource: usdRevenueSnapshot.source,
      pricingVersion: catalog.version,
    });

    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: {
        id: true,
        email: true,
        name: true,
        plan: true,
        stripeCustomerId: true,
        creditDebtCredits: true,
      },
    });
    if (!user) return NextResponse.json({ error: "User not found." }, { status: 404 });
    const plan = normalizePlan(user.plan);
    if (!pack.allowedPlans.includes(plan)) {
      return NextResponse.json(
        { error: "This credit pack is not available for the current plan." },
        { status: 403 }
      );
    }

    const stripe = getStripe();
    let stripeProductId: string | null = null;
    if (pack.stripePriceId) {
      try {
        const existingPrice = await stripe.prices.retrieve(pack.stripePriceId);
        stripeProductId =
          typeof existingPrice.product === "string"
            ? existingPrice.product
            : existingPrice.product?.id || null;
      } catch (error) {
        console.warn("Credit-pack Stripe product lookup failed; using inline product data.", {
          packId: pack.id,
          errorName: error instanceof Error ? error.name : "UnknownError",
        });
      }
    }
    let customerId = user.stripeCustomerId;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email || undefined,
        name: user.name || undefined,
        metadata: { userId: user.id },
      });
      customerId = customer.id;
      await prisma.user.update({
        where: { id: user.id },
        data: { stripeCustomerId: customerId },
      });
    }
    const origin = getPublicAppOrigin(req);
    const purchaseSnapshot = analytics
      ? await getPurchaseAnalyticsSnapshot({
          userId: user.id,
          currentPlan: plan,
          creditDebtCredits: user.creditDebtCredits,
        }).catch((snapshotError) => {
          console.warn("Credit-pack purchase analytics snapshot failed.", {
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
        plan === "Max" ? "max" : plan === "Pro" ? "pro" : "free",
      planCreditsRemaining: 0,
      addonCreditsRemaining: 0,
    };
    const analyticsMetadata: Record<string, string> = analytics
      ? {
          analyticsClientId: analytics.client_id,
          analyticsSessionId: analytics.session_id,
          analyticsUtmSource: analytics.utm_source,
          analyticsUtmMedium: analytics.utm_medium,
          analyticsUtmCampaign: analytics.utm_campaign,
          analyticsLanguage: analytics.language,
          analyticsCountry: analytics.country,
          ...purchaseAnalyticsMetadata({
            context: purchaseContext,
            trigger,
            productId: pack.id,
            creditQuantity: pack.credits,
          }),
          analyticsValue: String(billingMinorToMajor(priceMinor, market.currency)),
          analyticsCurrency: market.currency,
        }
      : {};
    const checkout = await stripe.checkout.sessions.create({
      mode: "payment",
      customer: customerId,
      client_reference_id: user.id,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: market.currency.toLowerCase(),
            unit_amount: priceMinor,
            product: stripeProductId || undefined,
            product_data: stripeProductId
              ? undefined
              : {
                  name: `Tomverse ${pack.name}`,
                  description: `${pack.credits.toLocaleString("en-US")} additional AI credits · valid for 12 months`,
                  metadata: { packId: pack.id },
                },
          },
        },
      ],
      payment_intent_data: {
        metadata: {
          purchaseType: "credit_pack",
          packId: pack.id,
          userId: user.id,
          ...billingMetadata,
        },
      },
      metadata: {
        purchaseType: "credit_pack",
        packId: pack.id,
        userId: user.id,
        ...billingMetadata,
        ...analyticsMetadata,
      },
      success_url: `${origin}/chat?billing=credits-success&pack=${encodeURIComponent(pack.id)}${
        language ? `&lang=${encodeURIComponent(language)}` : ""
      }`,
      cancel_url: `${origin}/chat?billing=credits-cancelled`,
      allow_promotion_codes: false,
    });
    return NextResponse.json({ url: checkout.url });
  } catch (error) {
    if (error instanceof BillingMarketValidationError) {
      return NextResponse.json(
        { code: error.code, error: error.message },
        { status: 400 }
      );
    }
    const response = apiSecurityResponse(error);
    if (response) return response;
    console.error("Failed to create credit-pack checkout:", error);
    return NextResponse.json({ error: "Failed to start credit-pack checkout." }, { status: 500 });
  }
}
