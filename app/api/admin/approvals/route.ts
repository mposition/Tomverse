export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { authOptions } from "@/lib/auth";
import { writeAdminAuditLog } from "@/lib/adminAudit";
import { hasAdminPermission, isAdminSession } from "@/lib/adminAuth";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
  readLimitedJson,
} from "@/lib/apiSecurity";
import { prisma } from "@/lib/prisma";

const createApprovalSchema = z
  .object({
    action: z.string().trim().min(3).max(120),
    targetType: z.string().trim().min(2).max(80),
    targetId: z.string().trim().max(200).optional(),
    reason: z.string().trim().min(5).max(800),
    payload: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const reviewApprovalSchema = z
  .object({
    approvalId: z.string().trim().min(5).max(120),
    status: z.enum(["approved", "rejected"]),
    reason: z.string().trim().max(800).optional(),
  })
  .strict();

export async function GET(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }

    await consumeApiRateLimit(req, session.user.id, "admin-approvals-read", {
      minute: 40,
      day: 800,
    });

    const approvals = await prisma.adminActionApproval.findMany({
      orderBy: { createdAt: "desc" },
      take: 60,
    });
    return NextResponse.json({ approvals });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Failed to load admin approvals:", error);
    return NextResponse.json(
      { error: "Failed to load approval queue." },
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

    await consumeApiRateLimit(req, session.user.id, "admin-approvals-write", {
      minute: 10,
      day: 100,
    });

    const body = await readLimitedJson(req, 8 * 1024, createApprovalSchema);
    const approval = await prisma.adminActionApproval.create({
      data: {
        action: body.action,
        targetType: body.targetType,
        targetId: body.targetId || null,
        reason: body.reason,
        payload: body.payload as Prisma.InputJsonValue | undefined,
        requestedById: session.user.id,
        requestedByEmail: session.user.email || null,
      },
    });

    await writeAdminAuditLog({
      session,
      request: req,
      action: "admin_approval.requested",
      targetType: "AdminActionApproval",
      targetId: approval.id,
      summary: `Requested approval for ${approval.action}.`,
      metadata: {
        targetType: approval.targetType,
        targetId: approval.targetId,
      },
    });

    return NextResponse.json({ approval });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Failed to create admin approval:", error);
    return NextResponse.json(
      { error: "Failed to create approval request." },
      { status: 500 }
    );
  }
}

export async function PATCH(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    if (!hasAdminPermission(session, "billing:write")) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }

    await consumeApiRateLimit(req, session.user.id, "admin-approvals-review", {
      minute: 12,
      day: 120,
    });

    const body = await readLimitedJson(req, 4 * 1024, reviewApprovalSchema);
    const approval = await prisma.adminActionApproval.update({
      where: { id: body.approvalId },
      data: {
        status: body.status,
        reason: body.reason || undefined,
        reviewedAt: new Date(),
        reviewedById: session.user.id,
        reviewedByEmail: session.user.email || null,
      },
    });

    await writeAdminAuditLog({
      session,
      request: req,
      action: `admin_approval.${body.status}`,
      targetType: "AdminActionApproval",
      targetId: approval.id,
      summary: `${body.status} approval for ${approval.action}.`,
      metadata: {
        targetType: approval.targetType,
        targetId: approval.targetId,
      },
    });

    return NextResponse.json({ approval });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Failed to review admin approval:", error);
    return NextResponse.json(
      { error: "Failed to review approval request." },
      { status: 500 }
    );
  }
}
