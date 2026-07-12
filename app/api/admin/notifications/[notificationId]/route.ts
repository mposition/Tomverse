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

const acknowledgeSchema = z
  .object({
    action: z.enum(["acknowledge"]),
  })
  .strict();

type RouteContext = {
  params: Promise<{ notificationId: string }>;
};

export async function PATCH(req: Request, context: RouteContext) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    if (!hasAdminPermission(session, "ops:write")) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }

    await consumeApiRateLimit(req, session.user.id, "admin-notification-ack", {
      minute: 20,
      day: 200,
    });

    await readLimitedJson(req, 1024, acknowledgeSchema);
    const { notificationId } = await context.params;
    const notification = await prisma.adminNotificationLog.update({
      where: { id: notificationId },
      data: {
        acknowledgedAt: new Date(),
        acknowledgedById: session.user.id,
        acknowledgedByEmail: session.user.email || null,
      },
    });

    await writeAdminAuditLog({
      session,
      request: req,
      action: "notification.acknowledged",
      targetType: "AdminNotificationLog",
      targetId: notification.id,
      summary: `Acknowledged ${notification.channel} alert: ${notification.title}.`,
      metadata: {
        channel: notification.channel,
        status: notification.status,
      },
    });

    return NextResponse.json({ success: true, notification });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Failed to acknowledge notification:", error);
    return NextResponse.json(
      { error: "Failed to acknowledge notification." },
      { status: 500 }
    );
  }
}
