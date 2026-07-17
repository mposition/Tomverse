export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import type { Session } from "next-auth";
import { authOptions } from "@/lib/auth";
import { hasAdminPermission, isAdminSession } from "@/lib/adminAuth";
import { writeAdminAuditLog } from "@/lib/adminAudit";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
} from "@/lib/apiSecurity";
import { sendTransactionalEmail } from "@/lib/email";

export async function POST(req: Request) {
  let auditSession: Session | null = null;
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !session.user.email || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    if (!hasAdminPermission(session, "ops:write")) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }
    auditSession = session;

    await consumeApiRateLimit(req, session.user.id, "admin-test-email", {
      minute: 5,
      day: 30,
    });

    await writeAdminAuditLog({
      session,
      request: req,
      action: "email.test.send_started",
      targetType: "Email",
      targetId: session.user.email,
      summary: `Started a test email delivery to ${session.user.email}.`,
    });

    const result = await sendTransactionalEmail({
      to: session.user.email,
      subject: "Tomverse AI test email",
      text: [
        "This is a Tomverse AI transactional email test.",
        "If you received this message, RESEND_API_KEY and TRANSACTIONAL_EMAIL_FROM are working.",
      ].join("\n"),
      html: `
        <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111827;">
          <h1 style="font-size:24px;margin:0 0 12px;">Tomverse AI test email</h1>
          <p>This is a Tomverse AI transactional email test.</p>
          <p>If you received this message, <strong>RESEND_API_KEY</strong> and <strong>TRANSACTIONAL_EMAIL_FROM</strong> are working.</p>
        </div>
      `,
    });
    await writeAdminAuditLog({
      session,
      request: req,
      action: "email.test.sent",
      targetType: "Email",
      targetId: session.user.email,
      summary: result.sent
        ? `Sent a test email to ${session.user.email}.`
        : `Test email to ${session.user.email} was skipped.`,
      metadata: {
        sent: result.sent,
        skipped: result.skipped,
        providerMessageId: result.id || null,
      },
    });

    return NextResponse.json({
      ok: true,
      sent: result.sent,
      skipped: result.skipped,
      id: result.id || null,
    });
  } catch (error) {
    if (auditSession) {
      await writeAdminAuditLog({
        session: auditSession,
        request: req,
        action: "email.test.failed",
        targetType: "Email",
        targetId: auditSession.user?.email || null,
        summary: `Test email failed: ${
          error instanceof Error ? error.message : "Unknown email provider error"
        }`,
        metadata: {
          errorName: error instanceof Error ? error.name : "UnknownError",
        },
      }).catch(() => undefined);
    }
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Admin test email failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Email test failed." },
      { status: 500 }
    );
  }
}
