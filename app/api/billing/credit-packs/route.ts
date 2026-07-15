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
import { getPurchasedCreditSummary } from "@/lib/creditLedger";
import { prisma } from "@/lib/prisma";
import { getPublicAppOrigin } from "@/lib/publicUrl";
import { getStripe } from "@/lib/stripe";
import type { ModelTier } from "@/lib/models";
import { analyticsAttributionSchema } from "@/lib/productAnalyticsShared";

const inputSchema = z
  .object({
    packId: z.string().max(32),
    analytics: analyticsAttributionSchema.optional(),
  })
  .strict();
const normalizePlan = (value: unknown): ModelTier =>
  value === "Pro" || value === "Max" ? value : "Free";

const publicPack = (pack: NonNullable<ReturnType<typeof getCreditPack>>) => ({
  id: pack.id,
  name: pack.name,
  credits: pack.credits,
  priceCents: pack.priceCents,
  currency: pack.currency,
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
      select: { plan: true },
    });
    if (!user) return NextResponse.json({ error: "User not found." }, { status: 404 });
    const plan = normalizePlan(user.plan);
    const balance = await getPurchasedCreditSummary(session.user.id);
    return NextResponse.json({
      plan,
      packs: getCreditPacksForPlan(plan).map(publicPack),
      balance: {
        ...balance,
        earliestExpiry: balance.earliestExpiry?.toISOString() || null,
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
    const { packId, analytics } = await readLimitedJson(req, 4 * 1024, inputSchema);
    const pack = getCreditPack(packId);
    if (!pack) return NextResponse.json({ error: "Credit pack not found." }, { status: 404 });

    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { id: true, email: true, name: true, plan: true, stripeCustomerId: true },
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
    const analyticsMetadata = analytics
      ? {
          analyticsClientId: analytics.client_id,
          analyticsSessionId: analytics.session_id,
          analyticsUtmSource: analytics.utm_source,
          analyticsUtmMedium: analytics.utm_medium,
          analyticsUtmCampaign: analytics.utm_campaign,
          analyticsLanguage: analytics.language,
          analyticsCountry: analytics.country,
        }
      : {};
    const checkout = await stripe.checkout.sessions.create({
      mode: "payment",
      customer: customerId,
      client_reference_id: user.id,
      line_items: [
        pack.stripePriceId
          ? { price: pack.stripePriceId, quantity: 1 }
          : {
              quantity: 1,
              price_data: {
                currency: pack.currency.toLowerCase(),
                unit_amount: pack.priceCents,
                product_data: {
                  name: `Tomverse ${pack.name}`,
                  description: `${pack.credits.toLocaleString("en-US")} additional AI credits · valid for 12 months`,
                  metadata: { packId: pack.id },
                },
              },
            },
      ],
      payment_intent_data: {
        metadata: { purchaseType: "credit_pack", packId: pack.id, userId: user.id },
      },
      metadata: {
        purchaseType: "credit_pack",
        packId: pack.id,
        userId: user.id,
        ...analyticsMetadata,
      },
      success_url: `${origin}/chat?billing=credits-success&pack=${encodeURIComponent(pack.id)}`,
      cancel_url: `${origin}/chat?billing=credits-cancelled`,
      allow_promotion_codes: false,
    });
    return NextResponse.json({ url: checkout.url });
  } catch (error) {
    const response = apiSecurityResponse(error);
    if (response) return response;
    console.error("Failed to create credit-pack checkout:", error);
    return NextResponse.json({ error: "Failed to start credit-pack checkout." }, { status: 500 });
  }
}
