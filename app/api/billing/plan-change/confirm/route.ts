export const dynamic = "force-dynamic";

/**
 * Execute a quote the customer confirmed.
 *
 * `requestId` is required: it names the exact quote being confirmed, which is
 * what lets the server prove it is charging the amount the customer saw, and
 * what makes a repeated confirm resolve to one change at Stripe rather than
 * two.
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
import { confirmPlanChange } from "@/lib/planChangeService";
import { isStripeConfigured } from "@/lib/stripe";

const confirmSchema = z
  .object({
    requestId: z.string().min(1).max(64),
    /**
     * Only ever true when the customer ticked a control that says so. The
     * confirm button alone is consent to change plan, not to resume a
     * subscription they had cancelled.
     */
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

    await consumeApiRateLimit(req, session.user.id, "billing-plan-change-confirm", {
      minute: 5,
      day: 20,
    });

    if (!isStripeConfigured()) {
      return NextResponse.json(
        { code: "STRIPE_NOT_CONFIGURED", error: "Stripe is not configured." },
        { status: 503 }
      );
    }

    const body = await readLimitedJson(req, 2 * 1024, confirmSchema);
    const result = await confirmPlanChange({
      userId: session.user.id,
      requestId: body.requestId,
      resumeRenewal: body.resumeRenewal ?? false,
    });

    if (!result.ok) {
      return NextResponse.json(
        { code: result.code, error: result.reason },
        { status: result.status }
      );
    }

    return NextResponse.json({ success: true, reservation: result.reservation });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Plan change confirmation failed:", error);
    return NextResponse.json(
      { code: "STRIPE_ERROR", error: "Failed to change the plan." },
      { status: 500 }
    );
  }
}
