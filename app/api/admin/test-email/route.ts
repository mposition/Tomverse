export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { isAdminSession } from "@/lib/adminAuth";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
} from "@/lib/apiSecurity";
import { sendTransactionalEmail } from "@/lib/email";

export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !session.user.email || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }

    await consumeApiRateLimit(req, session.user.id, "admin-test-email", {
      minute: 5,
      day: 30,
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

    return NextResponse.json({
      ok: true,
      sent: result.sent,
      skipped: result.skipped,
      id: result.id || null,
    });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Admin test email failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Email test failed." },
      { status: 500 }
    );
  }
}
