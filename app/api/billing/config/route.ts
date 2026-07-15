export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
} from "@/lib/apiSecurity";
import {
  getDefaultBillingPlans,
  getPublicBillingConfig,
} from "@/lib/billingConfig";
import { withDisplayCurrency } from "@/lib/billingCurrency";

const isDatabaseDisabledForE2e = () =>
  process.env.E2E_AUTH_BYPASS === "true" &&
  process.env.E2E_DISABLE_DATABASE === "true";

export async function GET(req: Request) {
  try {
    if (isDatabaseDisabledForE2e()) {
      return NextResponse.json(
        {
          plans: getDefaultBillingPlans().filter((plan) => plan.isActive),
          featuredPromotion: null,
          promotionPolicy: {
            codesListed: false,
            validation: "server_only",
            annualDiscountStacking: "promotion_specific_default_denied",
          },
        },
        { headers: { "Cache-Control": "no-store, max-age=0" } }
      );
    }

    const session = await getServerSession(authOptions);
    await consumeApiRateLimit(req, session?.user?.id || "guest", "billing-config-read", {
      minute: 60,
      day: 2_000,
    });
    const config = await getPublicBillingConfig();
    return NextResponse.json(await withDisplayCurrency(config, req), {
      headers: { "Cache-Control": "no-store, max-age=0" },
    });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Failed to load billing config:", error);
    return NextResponse.json(
      { error: "Failed to load billing config." },
      { status: 500 }
    );
  }
}
