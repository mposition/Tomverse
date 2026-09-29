export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { z } from "zod";

import { apiSecurityResponse, consumeApiRateLimit, readLimitedJson } from "@/lib/apiSecurity";
import { getAnonymousClientKey } from "@/lib/clientIp";
import { getTrustedIpCountry } from "@/lib/trustedIpCountry";
import { isValidLoginEmail, MAX_LOGIN_EMAIL_LENGTH } from "@/lib/emailValidation";
import { issueSignupConsentAttempt } from "@/lib/signupConsent";

/**
 * Stores the sign-up screen's consent choice before the account exists.
 *
 * Contract: docs/policy/email-product-news-redesign-draft.md sections 5.1 and
 * 5.2 (S4). Unauthenticated -- nobody is signed in yet -- so it is rate limited
 * by origin, and it stores nothing that identifies anybody but the address the
 * email-code channel is bound to. The response's nonce is the tab's
 * (`sessionStorage`); only its hash is kept.
 */

const bodySchema = z
  .object({
    channel: z.enum(["oauth", "email_code"]),
    provider: z.string().trim().max(40).optional(),
    email: z
      .string()
      .trim()
      .toLowerCase()
      .max(MAX_LOGIN_EMAIL_LENGTH)
      .refine(isValidLoginEmail, { message: "Invalid email address." })
      .optional(),
    expressOptInRequested: z.boolean(),
    objected: z.boolean(),
    language: z.string().trim().max(8).optional(),
    supersede: z
      .object({
        attemptId: z.string().trim().min(1).max(64),
        nonce: z.string().trim().min(1).max(128),
      })
      .strict()
      .optional(),
  })
  .strict();

export async function POST(req: Request) {
  try {
    await consumeApiRateLimit(
      req,
      `signup-consent:${getAnonymousClientKey(req)}`,
      "signup-consent",
      { minute: 10, day: 100 }
    );
    const body = await readLimitedJson(req, 2_048, bodySchema);
    const result = await issueSignupConsentAttempt({
      channel: body.channel,
      provider: body.provider ?? null,
      email: body.email ?? null,
      expressOptInRequested: body.expressOptInRequested,
      objected: body.objected,
      language: body.language ?? null,
      ipCountry: getTrustedIpCountry(req.headers),
      supersede: body.supersede ?? null,
    });
    if (!result.ok) {
      // Disabled is not an error the screen shows: it simply stores nothing
      // and sign-in goes on.
      return NextResponse.json(
        { ok: false, reason: result.reason },
        { status: result.reason === "disabled" ? 404 : 400 }
      );
    }
    return NextResponse.json(
      {
        ok: true,
        attemptId: result.attemptId,
        nonce: result.nonce,
        expiresAt: result.expiresAt.toISOString(),
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    const secured = apiSecurityResponse(error);
    if (secured) return secured;
    console.error("Signup consent issue failed:", error);
    return NextResponse.json({ ok: false, reason: "failed" }, { status: 500 });
  }
}
