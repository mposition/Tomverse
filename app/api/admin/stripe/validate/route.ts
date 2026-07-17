export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { hasAdminPermission, isAdminSession } from "@/lib/adminAuth";
import { writeAdminAuditLog } from "@/lib/adminAudit";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
} from "@/lib/apiSecurity";
import { getBillingPlans } from "@/lib/billingConfig";
import { isStripeConfigured, getStripe } from "@/lib/stripe";

type ValidationResult = {
  planId: string;
  name: string;
  product: "ok" | "missing" | "error" | "not-configured";
  monthlyPrice: "ok" | "missing" | "error" | "not-configured";
  annualPrice: "ok" | "missing" | "error" | "not-configured";
  errors: string[];
};

const checkStripeId = async (
  kind: "product" | "price",
  id: string | null
): Promise<{ status: ValidationResult["product"]; error?: string }> => {
  if (!id) return { status: "missing" };
  if (!isStripeConfigured()) return { status: "not-configured", error: "STRIPE_SECRET_KEY is not configured." };
  try {
    const stripe = getStripe();
    if (kind === "product") {
      await stripe.products.retrieve(id);
    } else {
      await stripe.prices.retrieve(id);
    }
    return { status: "ok" };
  } catch (error) {
    return {
      status: "error",
      error: error instanceof Error ? error.message : `Could not retrieve Stripe ${kind}.`,
    };
  }
};

export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    if (!hasAdminPermission(session, "billing:write")) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }

    await consumeApiRateLimit(req, session.user.id, "admin-stripe-validate", {
      minute: 10,
      day: 100,
    });

    const plans = (await getBillingPlans()).filter((plan) => plan.id !== "free");
    const results: ValidationResult[] = [];
    for (const plan of plans) {
      const [product, monthlyPrice, annualPrice] = await Promise.all([
        checkStripeId("product", plan.stripeProductId),
        checkStripeId("price", plan.stripePriceId),
        checkStripeId("price", plan.stripeAnnualPriceId),
      ]);
      results.push({
        planId: plan.id,
        name: plan.name,
        product: product.status,
        monthlyPrice: monthlyPrice.status,
        annualPrice: annualPrice.status,
        errors: [product.error, monthlyPrice.error, annualPrice.error].filter(
          (error): error is string => Boolean(error)
        ),
      });
    }
    await writeAdminAuditLog({
      session,
      request: req,
      action: "stripe.configuration.validated",
      targetType: "StripeConfiguration",
      targetId: "billing-plans",
      summary: `Validated ${results.length} Stripe billing plan configurations.`,
      metadata: {
        plans: results.map((result) => ({
          planId: result.planId,
          product: result.product,
          monthlyPrice: result.monthlyPrice,
          annualPrice: result.annualPrice,
          errorCount: result.errors.length,
        })),
      },
    });

    return NextResponse.json({ results });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Stripe validation failed:", error);
    return NextResponse.json({ error: "Failed to validate Stripe IDs." }, { status: 500 });
  }
}
