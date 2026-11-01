export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { apiSecurityResponse, consumeApiRateLimit } from "@/lib/apiSecurity";
import {
  analyticsUserIdFor,
  ga4UserIdKey,
  ga4UserIdServerEnabled,
} from "@/lib/ga4UserId";

const noStore = { "Cache-Control": "private, no-store, max-age=0" };

/**
 * The signed-in account's GA4 User-ID (docs/policy/marketing-automation.md
 * §10.2). The browser asks only after the visitor accepted analytics
 * (lib/ga4UserIdPolicy.ts); this answers only while the notice is published,
 * the switch is on and the derivation key exists. Anything else is the same
 * 404, so the response says nothing about which condition failed.
 */
export async function POST(req: Request) {
  try {
    if (!ga4UserIdServerEnabled()) {
      return NextResponse.json({ error: "Not found." }, { status: 404, headers: noStore });
    }
    const session = await getServerSession(authOptions);
    const userId = session?.user?.id;
    if (!userId) {
      return NextResponse.json({ error: "Not found." }, { status: 404, headers: noStore });
    }
    await consumeApiRateLimit(req, userId, "analytics-user-id", {
      minute: 30,
      day: 1_000,
    });
    const analyticsUserId = analyticsUserIdFor(userId, ga4UserIdKey());
    if (!analyticsUserId) {
      return NextResponse.json({ error: "Not found." }, { status: 404, headers: noStore });
    }
    return NextResponse.json({ analyticsUserId }, { headers: noStore });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Analytics user id request failed.", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return NextResponse.json(
      { error: "Analytics user id is unavailable." },
      { status: 500, headers: noStore }
    );
  }
}
