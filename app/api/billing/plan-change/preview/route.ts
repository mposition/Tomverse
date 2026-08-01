export const dynamic = "force-dynamic";

/**
 * Quote a Pro <-> Max change. Changes nothing.
 *
 * Deliberately separate from `/api/billing/checkout`, whose three 409 blocks
 * stay exactly as they are: a plan change must never be reachable by starting a
 * second subscription, or an account ends up paying for two plans at once.
 */

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { z } from "zod";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
  readLimitedJson,
} from "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
import { previewPlanChange } from "@/lib/planChangeService";
import { isStripeConfigured } from "@/lib/stripe";

const previewSchema = z
  .object({
    targetTier: z.enum(["Pro", "Max"]),
    billingInterval: z.enum(["monthly", "annual"]),
    // Quoting is read-only, so consent only affects what the quote says will
    // happen to an existing cancellation.
    resumeRenewal: z.boolean().optional(),
  })
  .strict();

export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json(
        { code: "AUTHENTICATION_REQUIRED", error: "Authentication required." },
        { status: 401 }
      );
    }

    await consumeApiRateLimit(req, session.user.id, "billing-plan-change-preview", {
      minute: 10,
      day: 100,
    });

    if (!isStripeConfigured()) {
      return NextResponse.json(
        { code: "STRIPE_NOT_CONFIGURED", error: "Stripe is not configured." },
        { status: 503 }
      );
    }

    const body = await readLimitedJson(req, 2 * 1024, previewSchema);
    const result = await previewPlanChange({
      userId: session.user.id,
      targetTier: body.targetTier,
      targetInterval: body.billingInterval,
      resumeRenewal: body.resumeRenewal ?? false,
    });

    if (!result.ok) {
      return NextResponse.json(
        { code: result.code, error: result.reason },
        { status: result.status }
      );
    }

    return NextResponse.json({ success: true, quote: result.quote });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Plan change preview failed:", error);
    return NextResponse.json(
      { code: "STRIPE_ERROR", error: "Failed to price the plan change." },
      { status: 500 }
    );
  }
}
