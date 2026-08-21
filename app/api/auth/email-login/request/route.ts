export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { z } from "zod";
import { requestEmailLoginCode, EmailLoginError } from "@/lib/emailLogin";
import { apiSecurityResponse, readLimitedJson } from "@/lib/apiSecurity";
import { isValidLoginEmail, MAX_LOGIN_EMAIL_LENGTH } from "@/lib/emailValidation";

const requestSchema = z
  .object({
    // .refine with the same predicate the sign-in form pre-validates with,
    // so a request that passed client-side checks never disagrees here.
    email: z
      .string()
      .trim()
      .toLowerCase()
      .max(MAX_LOGIN_EMAIL_LENGTH)
      .refine(isValidLoginEmail, { message: "Invalid email address." }),
    turnstileToken: z.string().trim().min(1).max(2_048).optional(),
  })
  .strict();

const EMAIL_LOGIN_ERROR_STATUS: Record<EmailLoginError["code"], number> = {
  TURNSTILE_REQUIRED: 403,
  TURNSTILE_FAILED: 403,
  TURNSTILE_UNAVAILABLE: 503,
  RATE_LIMITED_MINUTE: 429,
  RATE_LIMITED_DAY: 429,
};

export async function POST(req: Request) {
  try {
    const body = await readLimitedJson(req, 2_048, requestSchema);
    const result = await requestEmailLoginCode(req, body.email, body.turnstileToken);

    // `delivered` is not an account-existence signal and cannot be used as one:
    // a provider outage refuses a registered address and an unregistered one
    // identically, and the code is minted and stored either way. Reporting it
    // is what lets the sign-in screen stop saying "check your email" when
    // nothing was sent (docs/policy/email-notifications.md §9.4a-3).
    if (!result.delivered) {
      return NextResponse.json(
        { ok: false, code: "SEND_FAILED" },
        { status: 502 }
      );
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof EmailLoginError) {
      const headers = new Headers({ "Content-Type": "application/json" });
      if (error.retryAfter) headers.set("Retry-After", String(error.retryAfter));
      return new Response(
        JSON.stringify({ ok: false, code: error.code }),
        { status: EMAIL_LOGIN_ERROR_STATUS[error.code], headers }
      );
    }
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Email login code request failed:", error);
    return NextResponse.json({ error: "Failed to send login code." }, { status: 500 });
  }
}
