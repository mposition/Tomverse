export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { z } from "zod";
import { authOptions } from "@/lib/auth";
import { apiSecurityResponse, consumeApiRateLimit, readLimitedJson } from "@/lib/apiSecurity";
import { assertRecentAccountAuthentication, isAccountReauthenticationError } from "@/lib/adminReauthentication";
import { DESKTOP_AUTH_VALUE, isDesktopRedirect } from "@/lib/desktopAuthContract";
import { DESKTOP_LINK_PROVIDERS, desktopLinkProviders, desktopSocialLoginEnabled } from "@/lib/desktopSocialLoginCore";
import { buildDesktopOAuthLinkAuthorizeUrl, OAuthLinkError } from "@/lib/oauthLink";

// Desktop adds Google or Microsoft to the signed-in account: step one, from the Desktop settings session. The answer is
// the provider's authorize URL (opened in the system browser) and the state that comes back to the loopback address.
const schema = z.object({
  provider: z.enum(DESKTOP_LINK_PROVIDERS),
  redirectUri: z.string().max(64).refine(isDesktopRedirect),
  codeChallenge: z.string().regex(DESKTOP_AUTH_VALUE),
}).strict();

const noStore = { "Cache-Control": "no-store" };

export async function POST(req: Request) {
  if (!desktopSocialLoginEnabled()) {
    return NextResponse.json({ ok: false, code: "NOT_AVAILABLE" }, { status: 503, headers: noStore });
  }
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Authentication required." }, { status: 401, headers: noStore });
    }
    await consumeApiRateLimit(req, session.user.id, "desktop-login-method-link-start", { minute: 5, day: 20 });
    await assertRecentAccountAuthentication(session);
    const body = await readLimitedJson(req, 1_024, schema);
    if (!desktopLinkProviders().includes(body.provider)) {
      return NextResponse.json({ ok: false, code: "NOT_CONFIGURED" }, { status: 400, headers: noStore });
    }
    const { url, linkState } = buildDesktopOAuthLinkAuthorizeUrl(req, session.user.id, body.provider, body);
    return NextResponse.json({ ok: true, url, linkState }, { headers: noStore });
  } catch (error) {
    if (isAccountReauthenticationError(error)) {
      return NextResponse.json(
        { error: "Sign in again before linking a login method.", code: "ACCOUNT_REAUTHENTICATION_REQUIRED" },
        { status: 428, headers: noStore }
      );
    }
    if (error instanceof OAuthLinkError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: 400, headers: noStore });
    }
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Desktop OAuth link start failed:", error);
    return NextResponse.json({ error: "Failed to start linking." }, { status: 500, headers: noStore });
  }
}
