export const dynamic = "force-dynamic";

/**
 * Releases one device (design D14, D11).
 *
 * **Not exempt from the mutation-origin check, and not reachable from the app
 * yet.** D14 puts this route behind N1b, and `N1B_BEARER_ROUTES` ships empty by
 * approval, so a native POST here is refused at the proxy with 403. That is the
 * intended state: the route exists, is tested, and is a precondition for being
 * registered later -- one route at a time, each with evidence that its identity
 * and ownership checks read the bearer rather than the cookie session (D18).
 * This handler is that evidence for this route: it calls no session helper.
 *
 * Scope is D11's narrowest: the named device's families end, the other devices
 * keep working, and the web session is untouched.
 */

import { NextResponse } from "next/server";

import { apiSecurityResponse } from "@/lib/apiSecurity";
import { revokeMobileDevice } from "@/lib/mobileAuthService";
import { requireMobileBearer } from "@/lib/mobileAuthRoute";

export async function POST(
  request: Request,
  context: { params: Promise<{ deviceId: string }> }
) {
  try {
    const bearer = await requireMobileBearer(request);
    if (!bearer.ok) return bearer.response;

    const { deviceId } = await context.params;
    const result = await revokeMobileDevice({
      userId: bearer.identity.userId,
      deviceId,
    });
    if (!result.ok) {
      // Another account's device is "not found" rather than "refused". The
      // lookup is scoped by userId, so there is no branch that could report the
      // difference even if someone wanted it to.
      return NextResponse.json({ ok: false, code: "NOT_FOUND" }, { status: 404 });
    }
    return new Response(null, { status: 204 });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Mobile device revoke failed:", error);
    return NextResponse.json({ ok: false, code: "DEVICE_REVOKE_FAILED" }, { status: 500 });
  }
}
