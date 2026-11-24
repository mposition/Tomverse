import { z } from "zod";
import { readLimitedJson } from "@/lib/apiSecurity";
import { DESKTOP_AUTH_VALUE } from "@/lib/desktopAuthContract";
import { desktopAuthEnabled, desktopAuthNoStore, desktopAuthResponse, desktopAuthUnavailable, desktopLoginContext } from "@/lib/desktopAuthServer";
import { MOBILE_AUTH_ERROR_CODES } from "@/lib/mobileAuthContract";
import { enforceMobileAuthAdmission, mobileApiSecurityResponse, mobileAuthRefusal } from "@/lib/mobileAuthRoute";
import { issueMobileSession } from "@/lib/mobileAuthService";
import { consumeMobileLoginGrant, isPkceVerifier } from "@/lib/mobileLoginGrant";

const schema = z.object({
  ...desktopLoginContext,
  grant: z.string().regex(DESKTOP_AUTH_VALUE),
  codeVerifier: z.string().refine(isPkceVerifier),
  appVersion: z.string().trim().max(32).optional(),
}).strict();

export async function POST(request: Request) {
  if (!desktopAuthEnabled()) return desktopAuthUnavailable();
  if (request.headers.has("origin")) return desktopAuthResponse({ ok: false, code: "INVALID_ORIGIN" }, 403);
  try {
    await enforceMobileAuthAdmission(request, "desktop");
    const body = await readLimitedJson(request, 2048, schema);
    const grant = await consumeMobileLoginGrant({ grant: body.grant, codeVerifier: body.codeVerifier, desktop: body });
    if (!grant.ok) return desktopAuthNoStore(mobileAuthRefusal(MOBILE_AUTH_ERROR_CODES.refreshRejected));

    const issued = await issueMobileSession({
      request,
      userId: grant.userId,
      deviceLabel: "Tomverse Desktop",
      platform: "desktop",
      appVersion: body.appVersion,
    });
    return desktopAuthResponse({ ok: true, ...issued.tokens });
  } catch (error) {
    return desktopAuthNoStore(mobileApiSecurityResponse(error) ?? desktopAuthResponse({ ok: false, code: "EXCHANGE_FAILED" }, 500));
  }
}
