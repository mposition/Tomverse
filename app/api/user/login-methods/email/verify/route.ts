export const dynamic = "force-dynamic";

import { after, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { z } from "zod";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { verifyEmailLoginCodeForOwnAccount } from "@/lib/emailLogin";
import { apiSecurityResponse, consumeApiRateLimit, readLimitedJson } from "@/lib/apiSecurity";
import { logSecurityAuditEvent } from "@/lib/securityAudit";
import { sendLoginMethodChangedEmail } from "@/lib/emailLoginEmails";
import { reportOperationalIncident } from "@/lib/operationalMonitoring";

const verifySchema = z
  .object({
    code: z.string().trim().length(6),
  })
  .strict();

export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !session.user.email) {
      return NextResponse.json({ error: "Authentication required." }, { status: 401 });
    }
    await consumeApiRateLimit(req, session.user.id, "user-login-method-email-verify", {
      minute: 10,
      day: 40,
    });
    const body = await readLimitedJson(req, 512, verifySchema);

    const result = await verifyEmailLoginCodeForOwnAccount(req, session.user.email, body.code);
    if (!result.ok) {
      return NextResponse.json(
        { ok: false, code: result.reason === "locked" ? "EMAIL_CODE_LOCKED" : "EMAIL_CODE_INVALID" },
        { status: result.reason === "locked" ? 429 : 400 }
      );
    }

    await prisma.user.update({
      where: { id: session.user.id },
      data: { emailLoginEnabled: true },
    });
    logSecurityAuditEvent("auth.login_method.link", {
      userId: session.user.id,
      provider: "email",
      outcome: "success",
    });

    after(async () => {
      try {
        await sendLoginMethodChangedEmail({
          to: session.user.email,
          action: "linked",
          method: "email",
        });
      } catch (error) {
        await reportOperationalIncident({
          code: "LOGIN_METHOD_NOTIFICATION_FAILED",
          title: "Login-method-linked notification failed",
          error,
          severity: "warning",
          context: { component: "login-methods" },
        });
      }
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Email login enable verify failed:", error);
    return NextResponse.json({ error: "Failed to verify code." }, { status: 500 });
  }
}
