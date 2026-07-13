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
import { getTrustedClientIp } from "@/lib/clientIp";

const validationSchema = z
  .object({
    planId: z.enum(["pro", "max"]),
    billingInterval: z.enum(["monthly", "annual"]),
    promoCode: z.string().trim().toUpperCase().min(2).max(32),
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
      session?.user?.id || `guest:${getTrustedClientIp(req)}`;
    await consumeApiRateLimit(req, subject, "billing-promotion-validate", {
      minute: 10,
      day: 50,
    });
    const input = await readLimitedJson(req, 2 * 1024, validationSchema);
    const result = await validatePromotionForCheckout({
      code: input.promoCode,
      planId: input.planId,
      billingInterval: input.billingInterval,
      userId: session?.user?.id || null,
      request: req,
    });

    if (!result.valid) {
      return json(
        {
          valid: false,
          error:
            result.reason === "already_used"
              ? "This promotion code has already been used by this account."
              : "Invalid promotion code.",
        },
        result.reason === "already_used" ? 409 : 400
      );
    }

    return json({
      valid: true,
      promotion: {
        discountPercent: result.promotion.discountPercent,
        discountAmountCents: result.promotion.discountAmountCents,
        durationMonths: result.promotion.durationMonths,
        allowAnnualStacking: result.promotion.allowAnnualStacking,
      },
    });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Promotion validation failed:", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return json({ error: "Promotion validation failed." }, 500);
  }
}
