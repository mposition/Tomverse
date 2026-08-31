export const dynamic = "force-dynamic";

/**
 * The account's own device list (design D14, D16).
 *
 * A GET, so the mutation-origin check does not apply and this needs no
 * exemption. Authenticated by the access token, verified here independently of
 * whatever proxy decided (D2).
 *
 * What the list does not contain is the design: no IP, truncated or otherwise
 * (approved decision 8), no hardware fingerprint, no advertising identifier, no
 * OS build. A device list rich enough to be useful is also a location history
 * for whoever takes the account over.
 */

import { NextResponse } from "next/server";

import { apiSecurityResponse } from "@/lib/apiSecurity";
import { listMobileDevices } from "@/lib/mobileAuthService";
import { requireMobileBearer } from "@/lib/mobileAuthRoute";

export async function GET(request: Request) {
  try {
    const bearer = await requireMobileBearer(request);
    if (!bearer.ok) return bearer.response;

    const devices = await listMobileDevices(bearer.identity.userId);
    return NextResponse.json({
      ok: true,
      devices: devices.map((device) => ({
        ...device,
        // Which row is the caller's own phone. Computed rather than stored, so
        // the answer cannot drift from the token that asked.
        current: device.id === bearer.identity.deviceId,
      })),
    });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Mobile device list failed:", error);
    return NextResponse.json({ ok: false, code: "DEVICE_LIST_FAILED" }, { status: 500 });
  }
}
