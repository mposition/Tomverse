export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { z } from "zod";
import { authOptions } from "@/lib/auth";
import { apiSecurityResponse, consumeApiRateLimit, readLimitedJson } from "@/lib/apiSecurity";
import { assertRecentAccountAuthentication, isAccountReauthenticationError } from "@/lib/adminReauthentication";
import {
  DESKTOP_LINK_CODE_MAX_LENGTH, DESKTOP_LINK_STATE_MAX_LENGTH, DESKTOP_LINK_STATE_PREFIX, DESKTOP_LINK_VERIFIER,
  desktopSocialLoginEnabled,
} from "@/lib/desktopSocialLoginCore";
import { completeDesktopOAuthLink, OAuthLinkError } from "@/lib/oauthLink";

// Step two: the same Desktop settings session spends the provider's code with the PKCE verifier only Desktop holds.
const schema = z.object({
  linkState: z.string().max(DESKTOP_LINK_STATE_MAX_LENGTH).startsWith(DESKTOP_LINK_STATE_PREFIX),
  code: z.string().min(1).max(DESKTOP_LINK_CODE_MAX_LENGTH),
  codeVerifier: z.string().regex(DESKTOP_LINK_VERIFIER),
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
    await consumeApiRateLimit(req, session.user.id, "desktop-login-method-link-complete", { minute: 5, day: 20 });
    await assertRecentAccountAuthentication(session);
    const body = await readLimitedJson(req, 8_192, schema);
    const provider = await completeDesktopOAuthLink(req, session.user.id, body);
    return NextResponse.json({ ok: true, provider }, { headers: noStore });
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
    console.error("Desktop OAuth link complete failed:", error);
    return NextResponse.json({ error: "Failed to complete linking." }, { status: 500, headers: noStore });
  }
}
