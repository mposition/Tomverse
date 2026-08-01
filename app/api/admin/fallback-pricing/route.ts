export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { isAdminSession } from "@/lib/adminAuth";
import { apiSecurityResponse, consumeApiRateLimit } from "@/lib/apiSecurity";
import { getFallbackPricingReport } from "@/lib/fallbackPricingMetrics";

/**
 * Monitoring for the models still priced off the conservative fallback.
 *
 * The pending register records which prices are unverified and who owns them;
 * this says what that is costing in practice -- the share of decisions the
 * fallback touched, the refusals it was involved in, and how far its
 * reservations sat above what actually settled. Internal micro-USD figures are
 * included on purpose: this is the admin surface, not a user response.
 */
export async function GET(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    await consumeApiRateLimit(req, session.user.id, "admin-fallback-pricing", {
      minute: 30,
      day: 1_000,
    });

    const url = new URL(req.url);
    const requested = url.searchParams.get("days");
    const windowDays = requested === null ? undefined : Number(requested);
    if (requested !== null && !Number.isFinite(windowDays)) {
      return NextResponse.json(
        { error: "days must be a number.", code: "INVALID_WINDOW" },
        { status: 400 }
      );
    }

    return NextResponse.json(await getFallbackPricingReport({ windowDays }));
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Admin fallback pricing report failed:", error);
    return NextResponse.json(
      { error: "Failed to load the fallback pricing report." },
      { status: 500 }
    );
  }
}
