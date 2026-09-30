export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { z } from "zod";

import { apiSecurityResponse, consumeApiRateLimit, readLimitedJson } from "@/lib/apiSecurity";
import { getAnonymousClientKey } from "@/lib/clientIp";
import {
  SIGNUP_INTENT_COOKIE,
  SIGNUP_INTENT_MAX_AGE_SECONDS,
  SIGNUP_INTENT_PROVIDERS,
} from "@/lib/sessionRevocationCore";

/**
 * The sign-up screen says it means to create an account with this provider.
 *
 * Contract: docs/policy/email-product-news-redesign-draft.md section 5.2a (v25).
 * Called just before the provider redirect, whether or not the consent devices
 * are shown: sign-up works with them off. The OAuth `signIn` callback reads
 * the cookie; without it, a provider account with no account here is sent to
 * the sign-up screen rather than created. HttpOnly because nothing in the page
 * needs to read it, and scoped to the auth routes that do.
 */

const bodySchema = z.object({ provider: z.enum(SIGNUP_INTENT_PROVIDERS) }).strict();

const cookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/api/auth",
};

export async function POST(req: Request) {
  try {
    await consumeApiRateLimit(
      req,
      `signup-intent:${getAnonymousClientKey(req)}`,
      "signup-intent",
      { minute: 20, day: 200 }
    );
    const body = await readLimitedJson(req, 256, bodySchema);
    const response = NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
    response.cookies.set(SIGNUP_INTENT_COOKIE, body.provider, {
      ...cookieOptions,
      maxAge: SIGNUP_INTENT_MAX_AGE_SECONDS,
    });
    return response;
  } catch (error) {
    const secured = apiSecurityResponse(error);
    if (secured) return secured;
    console.error("Signup intent failed:", error);
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}

/**
 * Withdraws the intent. The sign-in screen calls this before a provider click,
 * so an intent the sign-up screen set a few minutes ago cannot turn that
 * sign-in into an account.
 */
export async function DELETE(req: Request) {
  try {
    await consumeApiRateLimit(
      req,
      `signup-intent:${getAnonymousClientKey(req)}`,
      "signup-intent",
      { minute: 20, day: 200 }
    );
    const response = NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
    response.cookies.set(SIGNUP_INTENT_COOKIE, "", { ...cookieOptions, maxAge: 0 });
    return response;
  } catch (error) {
    const secured = apiSecurityResponse(error);
    if (secured) return secured;
    console.error("Signup intent withdrawal failed:", error);
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
