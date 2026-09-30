export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getTrustedIpCountry } from "@/lib/trustedIpCountry";
import { getServerSession } from "next-auth/next";

import { authOptions } from "@/lib/auth";
import { apiSecurityResponse, consumeApiRateLimit } from "@/lib/apiSecurity";
import { recordSignInEstimatedCountry } from "@/lib/signupConsent";

/**
 * Records the country this signed-in request's IP estimates, for an account
 * that has none recorded.
 *
 * Contract: docs/policy/email-notifications.md sections 6.1 and 6.2 step 4;
 * docs/policy/email-product-news-redesign-draft.md section 5.3 item 6 (existing
 * accounts, at their next sign-in). The country is read from the edge's own
 * header, never from the body: a client cannot choose it. It never overwrites a
 * declaration or a billing country, and the person corrects it in settings.
 */
export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
    await consumeApiRateLimit(req, session.user.id, "jurisdiction-estimate", {
      minute: 5,
      day: 30,
    });
    const result = await recordSignInEstimatedCountry({
      userId: session.user.id,
      ipCountry: getTrustedIpCountry(req.headers),
    });
    // No country in the answer: the page has no use for it, and it is a
    // location signal.
    return NextResponse.json({ recorded: result.recorded }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const secured = apiSecurityResponse(error);
    if (secured) return secured;
    console.error("Jurisdiction estimate failed:", error);
    return NextResponse.json({ recorded: false }, { status: 500 });
  }
}
