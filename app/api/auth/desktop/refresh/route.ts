import { readDesktopRefreshToken, desktopAuthEnabled, desktopAuthNoStore, desktopAuthResponse, desktopAuthUnavailable } from "@/lib/desktopAuthServer";
import { MOBILE_AUTH_ERROR_CODES } from "@/lib/mobileAuthContract";
import { mobileApiSecurityResponse, mobileAuthRefusal } from "@/lib/mobileAuthRoute";
import { rotateMobileSession } from "@/lib/mobileAuthService";

export async function POST(request: Request) {
  if (!desktopAuthEnabled()) return desktopAuthUnavailable();
  if (request.headers.has("origin")) return desktopAuthResponse({ ok: false, code: "INVALID_ORIGIN" }, 403);
  try {
    const refreshToken = await readDesktopRefreshToken(request);
    const result = await rotateMobileSession({ request, refreshToken, client: "desktop" });
    return result.ok ? desktopAuthResponse({ ok: true, ...result.tokens })
      : desktopAuthNoStore(mobileAuthRefusal(MOBILE_AUTH_ERROR_CODES.refreshRejected));
  } catch (error) {
    return desktopAuthNoStore(mobileApiSecurityResponse(error) ?? desktopAuthResponse({ ok: false, code: "REFRESH_FAILED" }, 500));
  }
}
