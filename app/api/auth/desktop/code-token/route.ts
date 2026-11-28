import { consumeApiRateLimit } from "@/lib/apiSecurity";
import { desktopAuthEnabled, desktopAuthNoStore, desktopAuthResponse, desktopAuthUnavailable, requireDesktopBearer } from "@/lib/desktopAuthServer";
import { mintMobileAccessToken } from "@/lib/mobileAccessToken";
import { mobileApiSecurityResponse } from "@/lib/mobileAuthRoute";
import { desktopCodeSessionEnabled } from "@/lib/nativeBearerGate";

/**
 * The short token Desktop Code's runtimes carry (docs/policy/external-api.md section 11.2), for the Desktop session
 * that asks: the same account, device and token family, with the audience the coding API's engine calls accept and
 * nothing else does. A runtime therefore never holds the token Desktop's Chat and account routes take, and this token
 * cannot ask for another (only the Desktop session token reaches here). It lives as long as an access token, and each
 * use is checked against its family, so signing out or revoking the device ends it with the session.
 *
 * Bearer only, like the other Desktop session routes: a request with a cookie or an Origin is refused, so the
 * mutation-origin exemption (lib/requestOrigin.ts) never meets an ambient credential.
 */
export async function POST(request: Request) {
  if (!desktopAuthEnabled() || !desktopCodeSessionEnabled()) return desktopAuthUnavailable();
  if (request.headers.has("origin") || request.headers.has("cookie")) {
    return desktopAuthResponse({ ok: false, code: "INVALID_AUTH_CONTEXT" }, 403);
  }
  const auth = await requireDesktopBearer(request);
  if (!auth.ok) return auth.response;
  try {
    // Renewed with the session, every few minutes; generous for one Desktop, short of a loop.
    await consumeApiRateLimit(request, auth.identity.userId, "desktop-code-token", { minute: 20, day: 2_000 });
    const minted = mintMobileAccessToken({ ...auth.identity, client: "desktop-code" });
    return desktopAuthResponse({ ok: true, accessToken: minted.token, expiresIn: minted.expiresIn });
  } catch (error) {
    return desktopAuthNoStore(mobileApiSecurityResponse(error) ?? desktopAuthResponse({ ok: false, code: "CODE_TOKEN_FAILED" }, 500));
  }
}
