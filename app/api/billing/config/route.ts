export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
} from "@/lib/apiSecurity";
import { getPublicBillingConfig } from "@/lib/billingConfig";
import { withDisplayCurrency } from "@/lib/billingCurrency";

export async function GET(req: Request) {
  try {
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
