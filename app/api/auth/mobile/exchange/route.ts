export const dynamic = "force-dynamic";

/**
 * A grant becomes a session (design D14).
 *
 * Called by the Capacitor native layer, not by the WebView, so the refresh
 * token in the response never enters a JS heap (D19). It is one of the three
 * paths exempted from the mutation-origin check, and the condition attached to
 * that exemption is enforced here by construction: this handler never reads a
 * cookie. The only credential it accepts is in the body, and a body credential
 * is not ambient, so CSRF has nothing to work with.
 */

import { NextResponse } from "next/server";
import { z } from "zod";

import { mobileAuthReady } from "@/lib/mobileAccessToken";
import { apiSecurityResponse, readLimitedJson } from "@/lib/apiSecurity";
import { MOBILE_AUTH_ERROR_CODES, MOBILE_DEVICE_PLATFORMS } from "@/lib/mobileAuthContract";
import { issueMobileSession } from "@/lib/mobileAuthService";
import { consumeMobileLoginGrant, isPkceVerifier } from "@/lib/mobileLoginGrant";
import { enforceMobileAuthAdmission, mobileAuthRefusal } from "@/lib/mobileAuthRoute";

const requestSchema = z
  .object({
    grant: z.string().min(1).max(512),
    codeVerifier: z.string().refine(isPkceVerifier),
    // The person's own name for the device. Bounded, and stored as typed.
    deviceLabel: z.string().trim().min(1).max(64).optional(),
    platform: z.enum(MOBILE_DEVICE_PLATFORMS),
    appVersion: z.string().trim().max(32).optional(),
  })
  .strict();

export async function POST(request: Request) {
  try {
    if (!mobileAuthReady()) {
      return NextResponse.json({ ok: false, code: "NOT_AVAILABLE" }, { status: 503 });
    }
    // Before the body is even read: a refusal is the cheapest request a caller
    // can make, and these three paths are reachable without a subject.
    await enforceMobileAuthAdmission(request);
    const body = await readLimitedJson(request, 2_048, requestSchema);

    const consumed = await consumeMobileLoginGrant({
      grant: body.grant,
      codeVerifier: body.codeVerifier,
    });
    if (!consumed.ok) {
      // One refusal for unknown, expired, already-spent and wrong-binding. The
      // caller's next action is the same in all four -- start the sign-in
      // again -- and separating them would say which one it hit.
      return mobileAuthRefusal(MOBILE_AUTH_ERROR_CODES.refreshRejected);
    }

    const issued = await issueMobileSession({
      request,
      userId: consumed.userId,
      deviceLabel: body.deviceLabel ?? "Mobile",
      platform: body.platform,
      appVersion: body.appVersion ?? null,
    });
    return NextResponse.json({ ok: true, ...issued.tokens });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Mobile exchange failed:", error);
    return NextResponse.json({ ok: false, code: "EXCHANGE_FAILED" }, { status: 500 });
  }
}
