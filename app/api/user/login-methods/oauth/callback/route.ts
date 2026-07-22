export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import {
  completeOAuthLink,
  clearOAuthLinkStateCookie,
  OAuthLinkError,
  type LinkableProvider,
} from "@/lib/oauthLink";
import { sendLoginMethodChangedEmail } from "@/lib/emailLoginEmails";
import { getPublicAppOrigin } from "@/lib/publicUrl";

const isLinkableProvider = (value: string | null): value is LinkableProvider =>
  value === "google" || value === "azure-ad";

export async function GET(req: Request) {
  const origin = getPublicAppOrigin(req);
  const settingsUrl = (query: string) => `${origin}/chat?${query}`;

  const respond = (query: string) => {
    const response = NextResponse.redirect(settingsUrl(query), { status: 302 });
    response.headers.append("Set-Cookie", clearOAuthLinkStateCookie());
    return response;
  };

  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return respond("loginMethodLinkError=UNAUTHENTICATED");
    }

    const url = new URL(req.url);
    const provider = url.searchParams.get("provider");
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const providerError = url.searchParams.get("error");

    if (providerError) {
      return respond(`loginMethodLinkError=${encodeURIComponent(providerError)}`);
    }
    if (!isLinkableProvider(provider) || !code || !state) {
      return respond("loginMethodLinkError=INVALID_CALLBACK");
    }

    await completeOAuthLink(req, session.user.id, provider, code, state);

    try {
      await sendLoginMethodChangedEmail({
        to: session.user.email,
        action: "linked",
        method: provider,
      });
    } catch (error) {
      console.error("Failed to send login-method-linked email:", error);
    }

    return respond(`loginMethodLinked=${provider}`);
  } catch (error) {
    if (error instanceof OAuthLinkError) {
      return respond(`loginMethodLinkError=${encodeURIComponent(error.code)}`);
    }
    console.error("OAuth link callback failed:", error);
    return respond("loginMethodLinkError=UNKNOWN");
  }
}
