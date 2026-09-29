export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { z } from "zod";

import { authOptions } from "@/lib/auth";
import { apiSecurityResponse, consumeApiRateLimit, readLimitedJson } from "@/lib/apiSecurity";
import { finalizeSignupConsentAttempt } from "@/lib/signupConsent";

/**
 * Consumes the sign-up screen's consent choice for the account this sign-in
 * just created.
 *
 * Contract: docs/policy/email-product-news-redesign-draft.md section 5.2 (S4).
 * The session says who is asking; `finalizeSignupConsentAttempt()` decides
 * whether this account was created by the flow the choice belongs to, and an
 * existing account's sign-in never consumes one. Every refusal answers 200 with
 * its reason: the tab then forgets the choice, and the account exists either
 * way.
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
      attemptId: body.attemptId,
      nonce: body.nonce,
    });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const secured = apiSecurityResponse(error);
    if (secured) return secured;
    console.error("Signup consent finalize failed:", error);
    return NextResponse.json({ ok: false, reason: "failed" }, { status: 500 });
  }
}
