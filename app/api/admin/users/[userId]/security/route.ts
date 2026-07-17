export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";
import { z } from "zod";
import { authOptions } from "@/lib/auth";
import {
  adminApprovalErrorResponse,
  runWithAdminApproval,
} from "@/lib/adminApproval";
import { writeAdminAuditLog } from "@/lib/adminAudit";
import { hasAdminPermission, isAdminSession } from "@/lib/adminAuth";
import { assertRecentAdminAuthentication } from "@/lib/adminReauthentication";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
  readLimitedJson,
} from "@/lib/apiSecurity";
import { prisma } from "@/lib/prisma";
import { revokeAllUserSessions } from "@/lib/sessionSecurity";

const securityActionSchema = z
  .object({
    action: z.enum([
      "suspend",
      "unsuspend",
      "revoke_sessions",
      "restrict_ai",
      "unrestrict_ai",
      "unlink_oauth",
    ]),
    reason: z.string().trim().min(5).max(1_000),
    until: z.string().datetime().nullable().optional(),
    incidentNote: z.string().trim().max(2_000).nullable().optional(),
    provider: z.string().trim().min(2).max(80).nullable().optional(),
  })
  .strict();

type RouteContext = { params: Promise<{ userId: string }> };

export async function POST(req: Request, context: RouteContext) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    const { userId } = await context.params;
    if (userId === session.user.id) {
      return NextResponse.json(
        { error: "Administrators cannot apply emergency controls to themselves." },
        { status: 409 }
      );
    }
    const body = await readLimitedJson(req, 5 * 1024, securityActionSchema);
    const needsOwner = body.action === "unlink_oauth";
    if (
      needsOwner
        ? !hasAdminPermission(session, "user:delete")
        : !hasAdminPermission(session, "support:write") &&
          !hasAdminPermission(session, "ops:write")
    ) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }
    await consumeApiRateLimit(req, session.user.id, "admin-user-security", {
      minute: 10,
      day: 100,
    });
    const existing = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true },
    });
    if (!existing) {
      return NextResponse.json({ error: "User not found." }, { status: 404 });
    }

    const until = body.until ? new Date(body.until) : null;
    if (until && until <= new Date()) {
      return NextResponse.json(
        { error: "The control expiry must be in the future." },
        { status: 400 }
      );
    }

    if (body.action === "unlink_oauth") {
      await runWithAdminApproval(
        {
          session,
          request: req,
          action: "user.unlink_oauth",
          targetType: "User",
          targetId: userId,
          payload: body,
          reason: body.reason,
        },
        async () => {
          await prisma.account.deleteMany({
            where: {
              userId,
              ...(body.provider ? { provider: body.provider } : {}),
            },
          });
          await revokeAllUserSessions(userId);
        }
      );
    } else {
      await assertRecentAdminAuthentication(req, session);
      await writeAdminAuditLog({
        session,
        request: req,
        action: `user.security.${body.action}.started`,
        targetType: "User",
        targetId: userId,
        summary: `Started ${body.action} for ${existing.email || userId}.`,
        metadata: { reason: body.reason, until: until?.toISOString() || null },
      });
      if (body.action === "suspend") {
        await prisma.user.update({
          where: { id: userId },
          data: {
            accountStatus: "suspended",
            accountSuspendedAt: new Date(),
            accountSuspendedUntil: until,
            accountSuspensionReason: body.reason,
            accountSuspendedById: session.user.id,
            accountSuspendedByEmail: session.user.email || null,
            securityIncidentNote: body.incidentNote || undefined,
          },
        });
        await revokeAllUserSessions(userId);
      } else if (body.action === "unsuspend") {
        await prisma.user.update({
          where: { id: userId },
          data: {
            accountStatus: "active",
            accountDeletionRequestedAt: null,
            accountDeletionScheduledFor: null,
            accountSuspendedAt: null,
            accountSuspendedUntil: null,
            accountSuspensionReason: null,
            accountSuspendedById: null,
            accountSuspendedByEmail: null,
            securityIncidentNote: body.incidentNote || undefined,
          },
        });
      } else if (body.action === "restrict_ai") {
        await prisma.user.update({
          where: { id: userId },
          data: {
            aiUsageRestricted: true,
            aiUsageRestrictedAt: new Date(),
            aiUsageRestrictedUntil: until,
            aiUsageRestrictionReason: body.reason,
            aiUsageRestrictedById: session.user.id,
            aiUsageRestrictedByEmail: session.user.email || null,
            securityIncidentNote: body.incidentNote || undefined,
          },
        });
      } else if (body.action === "unrestrict_ai") {
        await prisma.user.update({
          where: { id: userId },
          data: {
            aiUsageRestricted: false,
            aiUsageRestrictedAt: null,
            aiUsageRestrictedUntil: null,
            aiUsageRestrictionReason: null,
            aiUsageRestrictedById: null,
            aiUsageRestrictedByEmail: null,
            securityIncidentNote: body.incidentNote || undefined,
          },
        });
      } else {
        await revokeAllUserSessions(userId);
      }
    }

    await writeAdminAuditLog({
      session,
      request: req,
      action: `user.security.${body.action}`,
      targetType: "User",
      targetId: userId,
      summary: `${body.action} applied to ${existing.email || userId}.`,
      metadata: {
        reason: body.reason,
        until: until?.toISOString() || null,
        provider: body.provider || null,
        hasIncidentNote: Boolean(body.incidentNote),
      },
    });

    const user = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: {
        accountStatus: true,
        accountSuspendedAt: true,
        accountSuspendedUntil: true,
        accountSuspensionReason: true,
        aiUsageRestricted: true,
        aiUsageRestrictedAt: true,
        aiUsageRestrictedUntil: true,
        aiUsageRestrictionReason: true,
        securityIncidentNote: true,
        _count: { select: { sessions: true, accounts: true } },
      },
    });
    return NextResponse.json({ user });
  } catch (error) {
    const approvalResponse = adminApprovalErrorResponse(error);
    if (approvalResponse) return approvalResponse;
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Admin user security control failed:", error);
    return NextResponse.json(
      { error: "Failed to apply user security control." },
      { status: 500 }
    );
  }
}
