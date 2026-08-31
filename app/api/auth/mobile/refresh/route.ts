export const dynamic = "force-dynamic";

/**
 * One rotation (design D14, section 4 option A).
 *
 * Strict single use: the presented token is spent and a successor returned, and
 * a second request with the same token is a replay that destroys the family.
 * There is no idempotency key and no grace window, so the app's single-flight
 * is a requirement rather than an optimisation (approved decision 4).
 *
 * Like exchange, this reads no cookie -- the condition on its mutation-origin
 * exemption.
 */

import { NextResponse } from "next/server";
import { z } from "zod";

import { apiSecurityResponse, readLimitedJson } from "@/lib/apiSecurity";
import { MOBILE_AUTH_ERROR_CODES } from "@/lib/mobileAuthContract";
import { mobileAuthConfigured } from "@/lib/mobileAuthKeyring";
import { rotateMobileSession } from "@/lib/mobileAuthService";
import { mobileAuthRefusal } from "@/lib/mobileAuthRoute";

const requestSchema = z.object({ refreshToken: z.string().min(1).max(512) }).strict();

export async function POST(request: Request) {
  try {
    if (!mobileAuthConfigured()) {
      return NextResponse.json({ ok: false, code: "NOT_AVAILABLE" }, { status: 503 });
    }
    const body = await readLimitedJson(request, 1_024, requestSchema);
    const result = await rotateMobileSession({
      request,
      refreshToken: body.refreshToken,
    });

    if (!result.ok) {
      // Expired, forged, replayed, wrong secret, and the loser of a race: one
      // code for all of them (D15). The precise reason is in the audit row,
      // where it informs an operator rather than an attacker.
      return mobileAuthRefusal(MOBILE_AUTH_ERROR_CODES.refreshRejected);
    }
    return NextResponse.json({ ok: true, ...result.tokens });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Mobile refresh failed:", error);
    return NextResponse.json({ ok: false, code: "REFRESH_FAILED" }, { status: 500 });
  }
}
