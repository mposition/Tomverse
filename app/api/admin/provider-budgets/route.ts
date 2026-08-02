export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { isAdminSession } from "@/lib/adminAuth";
import { apiSecurityResponse, consumeApiRateLimit } from "@/lib/apiSecurity";
import { getProviderBudgetStatuses } from "@/lib/providerBudgetStatus";

/**
 * What every active provider's spend budget is, what it was configured to be,
 * how much of it today and this month have used, and when each window resets.
 *
 * A provider budget refuses every user of that provider at once, so "how close
 * is it" has to be answerable before the refusal rather than reconstructed
 * after it. Internal micro-USD is included on purpose: this is the admin
 * surface, and the user-facing error carries none of it.
 */
export async function GET(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    await consumeApiRateLimit(req, session.user.id, "admin-provider-budgets", {
      minute: 30,
      day: 1_000,
    });

    return NextResponse.json(await getProviderBudgetStatuses());
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Admin provider budget report failed:", error);
    return NextResponse.json(
      { error: "Failed to load provider budgets." },
      { status: 500 }
    );
  }
}
