export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { consumeApiRateLimit, apiSecurityResponse } from "@/lib/apiSecurity";
import { assertRecentAdminAuthentication, isAdminReauthenticationError } from "@/lib/adminReauthentication";
import { buildOAuthLinkAuthorizeRedirect, OAuthLinkError, type LinkableProvider } from "@/lib/oauthLink";

const isLinkableProvider = (value: string | null): value is LinkableProvider =>
  value === "google" || value === "azure-ad";

export async function GET(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Authentication required." }, { status: 401 });
    }

    await consumeApiRateLimit(req, session.user.id, "user-login-method-oauth-start", {
      minute: 5,
      day: 20,
    });
    await assertRecentAdminAuthentication(session);

    const provider = new URL(req.url).searchParams.get("provider");
    if (!isLinkableProvider(provider)) {
      return NextResponse.json({ error: "Unsupported provider." }, { status: 400 });
    }

    const { url, cookie } = buildOAuthLinkAuthorizeRedirect(req, session.user.id, provider);
    const response = NextResponse.redirect(url, { status: 302 });
    response.headers.append("Set-Cookie", cookie);
    return response;
  } catch (error) {
    if (isAdminReauthenticationError(error)) {
      return NextResponse.json(
        { error: "Sign in again before linking a login method.", code: "ACCOUNT_REAUTHENTICATION_REQUIRED" },
        { status: 428 }
      );
    }
    if (error instanceof OAuthLinkError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: 400 });
    }
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("OAuth link start failed:", error);
    return NextResponse.json({ error: "Failed to start linking." }, { status: 500 });
  }
}
