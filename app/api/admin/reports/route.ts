export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { z } from "zod";
import { authOptions } from "@/lib/auth";
import { hasAdminPermission, isAdminSession } from "@/lib/adminAuth";
import { writeAdminAuditLog } from "@/lib/adminAudit";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
  readLimitedJson,
} from "@/lib/apiSecurity";
import { prisma } from "@/lib/prisma";

const reportSchema = z
  .object({
    title: z.string().trim().min(3).max(120).default("Tomverse operations report"),
    recipient: z.string().trim().email().optional(),
  })
  .strict();

export async function GET(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }

    await consumeApiRateLimit(req, session.user.id, "admin-reports-read", {
      minute: 20,
      day: 200,
    });

    const reports = await prisma.adminOperationReport.findMany({
      orderBy: { createdAt: "desc" },
      take: 20,
    });
    return NextResponse.json({ reports });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Failed to load admin reports:", error);
    return NextResponse.json(
      { error: "Failed to load reports." },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    if (!hasAdminPermission(session, "ops:write")) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }

    await consumeApiRateLimit(req, session.user.id, "admin-reports-write", {
      minute: 8,
      day: 80,
    });

    const body = await readLimitedJson(req, 2 * 1024, reportSchema);
    const now = new Date();
    const [users, paidUsers, openFeedback, pendingRefunds, failedAlerts, failedWebhooks] =
      await Promise.all([
        prisma.user.count(),
        prisma.user.count({
          where: {
            plan: { in: ["Pro", "Max"] },
            subscriptionStatus: { in: ["active", "trialing"] },
          },
        }),
        prisma.feedback.count({ where: { status: "open" } }),
        prisma.refundRequest.count({ where: { status: "pending" } }),
        prisma.adminNotificationLog.count({ where: { status: "failed" } }),
        prisma.stripeWebhookEventLog.count({ where: { status: "failed" } }),
      ]);
    const bodyText = [
      `Tomverse operations report`,
      `Generated: ${now.toISOString()}`,
      ``,
      `Users: ${users}`,
      `Active paid users: ${paidUsers}`,
      `Open feedback: ${openFeedback}`,
      `Pending refunds: ${pendingRefunds}`,
      `Failed alert deliveries: ${failedAlerts}`,
      `Failed Stripe webhooks: ${failedWebhooks}`,
    ].join("\n");

    const report = await prisma.adminOperationReport.create({
      data: {
        title: body.title,
        body: bodyText,
        status: body.recipient ? "created_email_not_configured" : "created",
        recipient: body.recipient || null,
        createdById: session.user.id,
        createdByEmail: session.user.email || null,
      },
    });

    await prisma.adminNotificationLog.create({
      data: {
        channel: "report",
        title: body.title,
        detail: bodyText,
        status: "sent",
        targetType: "AdminOperationReport",
        targetId: report.id,
      },
    });

    await writeAdminAuditLog({
      session,
      request: req,
      action: "report.created",
      targetType: "AdminOperationReport",
      targetId: report.id,
      summary: `Created admin operations report: ${body.title}.`,
      metadata: { recipient: body.recipient || null },
    });

    return NextResponse.json({ success: true, report });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Failed to create admin report:", error);
    return NextResponse.json(
      { error: "Failed to create report." },
      { status: 500 }
    );
  }
}
