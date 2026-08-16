export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";
import { z } from "zod";
import { authOptions } from "@/lib/auth";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
  readLimitedJson,
} from "@/lib/apiSecurity";
import { validatePromotionForCheckout } from "@/lib/billingPromotionSecurity";
import { promotionValidationError } from "@/lib/billingPromotionCore";
import {
  BillingMarketValidationError,
  validateBillingMarketRequest,
} from "@/lib/billingCurrency";
import { BILLING_CURRENCIES } from "@/lib/billingMarkets";
import { getAnonymousClientKey } from "@/lib/clientIp";

const validationSchema = z
  .object({
    planId: z.enum(["pro", "max"]),
    billingInterval: z.enum(["monthly", "annual"]),
    promoCode: z.string().trim().toUpperCase().min(2).max(32),
    // Sent so a market the client cannot reconcile with the edge is caught here
    // rather than at the button. Not authoritative: `validateBillingMarketRequest`
    // decides from the trusted edge country and refuses a mismatch, exactly as
    // /api/billing/checkout does. A client that omits them gets the same market
    // the edge would have given it anyway.
    currency: z.enum(BILLING_CURRENCIES).optional(),
    country: z.string().trim().length(2).optional(),
  })
  .strict();

const json = (body: unknown, status = 200) =>
  NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store, max-age=0" },
  });

export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    const subject =
      session?.user?.id || `guest:${getAnonymousClientKey(req)}`;
    await consumeApiRateLimit(req, subject, "billing-promotion-validate", {
      minute: 10,
      day: 50,
    });
    const input = await readLimitedJson(req, 2 * 1024, validationSchema);
    // The same market contract Checkout uses, from the same function. Deciding
    // it here is what makes the two endpoints agree about currency: a promotion
    // is only applicable against the currency the customer will be charged in,
    // and that is not the one the client asked for.
    const market = validateBillingMarketRequest({
      req,
      currency: input.currency,
      country: input.country,
    });
    const result = await validatePromotionForCheckout({
      code: input.promoCode,
      planId: input.planId,
      billingInterval: input.billingInterval,
      currency: market.currency,
      userId: session?.user?.id || null,
      request: req,
    });

    if (!result.valid) {
      const validationError = promotionValidationError(result.reason);
      return json(
        {
          valid: false,
          code: validationError.code,
          error: validationError.message,
        },
        validationError.status
      );
    }

    return json({
      valid: true,
      promotion: {
        discountPercent: result.promotion.discountPercent,
        discountAmountCents: result.promotion.discountAmountCents,
        durationMonths: result.promotion.durationMonths,
        fulfillmentType: result.promotion.fulfillmentType,
        accessDurationDays: result.promotion.accessDurationDays,
        paymentMethodRequired:
          result.promotion.fulfillmentType !== "internal_pass",
        automaticRenewal:
          result.promotion.fulfillmentType !== "internal_pass",
        allowAnnualStacking: result.promotion.allowAnnualStacking,
      },
    });
  } catch (error) {
    if (error instanceof BillingMarketValidationError) {
      return json({ valid: false, code: error.code, error: error.message }, 400);
    }
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Promotion validation failed:", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return json({ error: "Promotion validation failed." }, 500);
  }
}
