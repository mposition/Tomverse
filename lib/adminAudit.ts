import "server-only";

import type { Session } from "next-auth";
import type { Prisma } from "@prisma/client";
import { getTrustedClientIp } from "@/lib/clientIp";
import { prisma } from "@/lib/prisma";

type AuditInput = {
  session: Session;
  request?: Request;
  action: string;
  targetType: string;
  targetId?: string | null;
  summary: string;
  metadata?: Prisma.InputJsonValue | null;
};

const safeSummary = (value: string) => value.trim().slice(0, 500);

export async function writeAdminAuditLog({
  session,
  request,
  action,
  targetType,
  targetId,
  summary,
  metadata,
}: AuditInput) {
  try {
    await prisma.adminAuditLog.create({
      data: {
        actorUserId: session.user?.id || null,
        actorEmail: session.user?.email || null,
        action,
        targetType,
        targetId: targetId || null,
        summary: safeSummary(summary),
        metadata: metadata || undefined,
        ipAddress: request ? getTrustedClientIp(request) : null,
        userAgent: request?.headers.get("user-agent")?.slice(0, 500) || null,
      },
    });
  } catch (error) {
    console.error("Admin audit log write failed:", error);
  }
}
