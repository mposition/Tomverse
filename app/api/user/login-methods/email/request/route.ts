export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { requestEmailLoginCode, EmailLoginError } from "@/lib/emailLogin";
import { apiSecurityResponse, consumeApiRateLimit } from "@/lib/apiSecurity";

export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !session.user.email) {
      return NextResponse.json({ error: "Authentication required." }, { status: 401 });
    }
    await consumeApiRateLimit(req, session.user.id, "user-login-method-email-request", {
      minute: 2,
      day: 10,
    });

    await requestEmailLoginCode(req, session.user.email, undefined);
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof EmailLoginError) {
      return NextResponse.json({ ok: false, code: error.code }, { status: 403 });
    }
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Email login enable request failed:", error);
    return NextResponse.json({ error: "Failed to send login code." }, { status: 500 });
  }
}
