export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
} from "@/lib/apiSecurity";
import { getAnonymousClientKey } from "@/lib/clientIp";
import {
  getDefaultBillingPlans,
  getPublicBillingConfig,
} from "@/lib/billingConfig";
import { withDisplayCurrency } from "@/lib/billingCurrency";
import { getPublicCreditPackCatalog } from "@/lib/creditPacks";
import { isE2EFixtureMode } from "@/lib/e2eTestMode";

const isDatabaseDisabledForE2e = isE2EFixtureMode;

export async function GET(req: Request) {
  try {
    if (isDatabaseDisabledForE2e()) {
      const fallbackConfig = {
        plans: getDefaultBillingPlans().filter((plan) => plan.isActive),
        creditPacks: getPublicCreditPackCatalog(),
        featuredPromotion: null,
        promotionPolicy: {
          codesListed: false as const,
          validation: "server_only" as const,
          annualDiscountStacking: "promotion_specific_default_denied" as const,
        },
      };
      return NextResponse.json(
        await withDisplayCurrency(fallbackConfig, req),
        { headers: { "Cache-Control": "no-store, max-age=0" } }
      );
    }

    const session = await getServerSession(authOptions);
    // Per-caller, not a single shared "guest" bucket: the public pricing page
    // depends on this route, so one client must not be able to 429 everyone.
    await consumeApiRateLimit(
      req,
      session?.user?.id || `guest:${getAnonymousClientKey(req)}`,
      "billing-config-read",
      { minute: 60, day: 2_000 }
    );
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
