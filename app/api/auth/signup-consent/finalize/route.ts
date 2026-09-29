export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { z } from "zod";

import { authOptions } from "@/lib/auth";
import { apiSecurityResponse, consumeApiRateLimit, readLimitedJson } from "@/lib/apiSecurity";
import { finalizeSignupConsentAttempt, TERMINAL_FINALIZE_REFUSALS } from "@/lib/signupConsent";

/**
 * Consumes the sign-up screen's consent choice for the account this sign-in
 * just created.
 *
 * Contract: docs/policy/email-product-news-redesign-draft.md section 5.2 (S4).
 * The session says who is asking; `finalizeSignupConsentAttempt()` decides
 * whether this account was created by the flow the choice belongs to, and an
 * existing account's sign-in never consumes one. A refusal after which the
 * choice can never be consumed answers 200 with its reason, and the tab then
 * forgets it; one that rolled back and left the attempt pending
 * (`confirmation_unavailable`) answers 503, and the landing tries again a few
 * times before dropping it. The account exists either way.
 */

const bodySchema = z
  .object({
    attemptId: z.string().trim().min(1).max(64),
    nonce: z.string().trim().min(1).max(128),
  })
  .strict();

export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
    await consumeApiRateLimit(req, session.user.id, "signup-consent-finalize", {
      minute: 10,
      day: 50,
    });
    const body = await readLimitedJson(req, 1_024, bodySchema);
    const result = await finalizeSignupConsentAttempt({
      userId: session.user.id,
      createdBySignIn: session.user.accountCreatedBySignIn === true,
      attemptId: body.attemptId,
      nonce: body.nonce,
    });
    const retryable = !result.ok && !TERMINAL_FINALIZE_REFUSALS.has(result.reason);
    return NextResponse.json(result, {
      status: retryable ? 503 : 200,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const secured = apiSecurityResponse(error);
    if (secured) return secured;
    console.error("Signup consent finalize failed:", error);
    return NextResponse.json({ ok: false, reason: "failed" }, { status: 500 });
  }
}
