export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
} from "@/lib/apiSecurity";
import { getPublicBillingConfig } from "@/lib/billingConfig";

export async function GET(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    await consumeApiRateLimit(req, session?.user?.id || "guest", "billing-config-read", {
      minute: 60,
      day: 2_000,
    });
    return NextResponse.json(await getPublicBillingConfig());
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
