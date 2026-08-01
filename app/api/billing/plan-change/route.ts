export const dynamic = "force-dynamic";

/**
 * The in-flight plan change, and calling a scheduled one off.
 *
 * `GET` is what lets the account page say "Pro starts on 1 September" instead
 * of leaving a reserved downgrade invisible until it happens. `DELETE` calls it
 * off, which for a downgrade means releasing the schedule and leaving the
 * subscription exactly as it is.
 */

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { apiSecurityResponse, consumeApiRateLimit } from "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
import {
  cancelScheduledPlanChange,
  getActivePlanChange,
} from "@/lib/planChangeService";
import { isStripeConfigured } from "@/lib/stripe";

export async function GET(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json(
        { code: "AUTHENTICATION_REQUIRED", error: "Authentication required." },
        { status: 401 }
      );
    }

    await consumeApiRateLimit(req, session.user.id, "billing-plan-change-read", {
      minute: 30,
      day: 500,
    });

    const reservation = await getActivePlanChange(session.user.id);
    return NextResponse.json({ reservation });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Reading the active plan change failed:", error);
    return NextResponse.json(
      { error: "Failed to read the plan change." },
      { status: 500 }
    );
  }
}

export async function DELETE(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json(
        { code: "AUTHENTICATION_REQUIRED", error: "Authentication required." },
        { status: 401 }
      );
    }

    await consumeApiRateLimit(req, session.user.id, "billing-plan-change-cancel", {
      minute: 5,
      day: 20,
    });

    if (!isStripeConfigured()) {
      return NextResponse.json(
        { code: "STRIPE_NOT_CONFIGURED", error: "Stripe is not configured." },
        { status: 503 }
      );
    }

    const result = await cancelScheduledPlanChange({ userId: session.user.id });
    if (!result.ok) {
      return NextResponse.json(
        { code: result.code, error: result.reason },
        { status: result.status }
      );
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Cancelling a scheduled plan change failed:", error);
    return NextResponse.json(
      { code: "STRIPE_ERROR", error: "Failed to cancel the plan change." },
      { status: 500 }
    );
  }
}
