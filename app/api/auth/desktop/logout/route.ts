import { readDesktopRefreshToken, desktopAuthEnabled, desktopAuthNoStore, desktopAuthResponse, desktopAuthUnavailable } from "@/lib/desktopAuthServer";
import { mobileApiSecurityResponse } from "@/lib/mobileAuthRoute";
import { logoutMobileSession } from "@/lib/mobileAuthService";

export async function POST(request: Request) {
  if (!desktopAuthEnabled()) return desktopAuthUnavailable();
  if (request.headers.has("origin")) return desktopAuthResponse({ ok: false, code: "INVALID_ORIGIN" }, 403);
  try {
    const refreshToken = await readDesktopRefreshToken(request);
    await logoutMobileSession({ request, refreshToken, client: "desktop" });
    return desktopAuthNoStore(new Response(null, { status: 204 }));
  } catch (error) {
    return desktopAuthNoStore(mobileApiSecurityResponse(error) ?? desktopAuthResponse({ ok: false, code: "LOGOUT_FAILED" }, 500));
  }
}
