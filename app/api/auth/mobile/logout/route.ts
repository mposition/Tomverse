export const dynamic = "force-dynamic";

/**
 * Ends one device's session (design D14, as corrected in rev.2).
 *
 * The refresh token is in the body rather than an access token in a header, and
 * that is the correction: the most common moment to log out is when the access
 * token has already expired, so an access-authenticated logout would fail
 * exactly when it is wanted.
 *
 * **Always 204.** A valid token, an expired one, a forged one and a syntactic
 * nonsense all answer the same, because anything else makes this endpoint an
 * oracle for whether a token is real, and there is nothing a caller could do
 * differently with the answer. The service still applies D5's order: a wrong
 * secret revokes nothing.
 */

import { NextResponse } from "next/server";
import { z } from "zod";

import { mobileAuthReady } from "@/lib/mobileAccessToken";
import { readLimitedJson } from "@/lib/apiSecurity";
import { logoutMobileSession } from "@/lib/mobileAuthService";
import { enforceMobileAuthAdmission, mobileApiSecurityResponse } from "@/lib/mobileAuthRoute";

const requestSchema = z.object({ refreshToken: z.string().min(1).max(512) }).strict();

export async function POST(request: Request) {
  try {
    if (!mobileAuthReady()) {
      return NextResponse.json({ ok: false, code: "NOT_AVAILABLE" }, { status: 503 });
    }
    // Before the body is even read: a refusal is the cheapest request a caller
    // can make, and these three paths are reachable without a subject.
    await enforceMobileAuthAdmission(request);
    const body = await readLimitedJson(request, 1_024, requestSchema);
    await logoutMobileSession({ request, refreshToken: body.refreshToken });
    return new Response(null, { status: 204 });
  } catch (error) {
    // Rate limiting is the one thing a caller is told about, because it asks
    // them to wait rather than describing their token.
    const securityResponse = mobileApiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Mobile logout failed:", error);
    return NextResponse.json({ ok: false, code: "LOGOUT_FAILED" }, { status: 500 });
  }
}
