export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { z } from "zod";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { verifyEmailLoginCodeForOwnAccount } from "@/lib/emailLogin";
import { apiSecurityResponse, consumeApiRateLimit, readLimitedJson } from "@/lib/apiSecurity";
import { logSecurityAuditEvent } from "@/lib/securityAudit";
import {
  enqueueLoginMethodNotice,
  loginMethodNoticeLanguage,
  prepareLoginMethodNotice,
} from "@/lib/loginMethodNotice";

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

    // Before the transaction: registering a template version is not part of
    // whether a login method may be enabled (lib/loginMethodNotice.ts).
    await prepareLoginMethodNotice({
      action: "linked",
      language: await loginMethodNoticeLanguage(session.user.id),
    });
    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: session.user.id },
        data: { emailLoginEnabled: true },
      });
      // In the same transaction as the change, so the notice cannot be lost
      // while the new login method stands (section 7.4, C36).
      await enqueueLoginMethodNotice(tx, {
        userId: session.user.id,
        action: "linked",
        method: "email",
      });
    });
    logSecurityAuditEvent("auth.login_method.link", {
      userId: session.user.id,
      provider: "email",
      outcome: "success",
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Email login enable verify failed:", error);
    return NextResponse.json({ error: "Failed to verify code." }, { status: 500 });
  }
}
