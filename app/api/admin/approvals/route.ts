export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { authOptions } from "@/lib/auth";
import {
  approvalPayloadHash,
  approvalPermissionForAction,
  approvalTtlMinutes,
  canReviewAdminApproval,
  canonicalizeApprovalPayload,
} from "@/lib/adminApprovalCore";
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

    await prisma.adminActionApproval.updateMany({
      where: {
        status: { in: ["pending", "approved"] },
        expiresAt: { lte: new Date() },
      },
      data: { status: "expired" },
    });
    const [actionable, recent] = await Promise.all([
      prisma.adminActionApproval.findMany({
        where: { status: { in: ["pending", "approved"] } },
        orderBy: { createdAt: "asc" },
        take: 100,
      }),
      prisma.adminActionApproval.findMany({
        where: { status: { notIn: ["pending", "approved"] } },
        orderBy: { createdAt: "desc" },
        take: 40,
      }),
    ]);
    const approvals = [...actionable, ...recent];
    return NextResponse.json({
      approvals: approvals.map((approval) => ({
        ...approval,
        canReview:
          approval.status === "pending" &&
          approval.requestedById !== session.user.id &&
          hasAdminPermission(session, approvalPermissionForAction(approval.action)),
      })),
    });
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
    const payload = canonicalizeApprovalPayload(body.payload || {});
    const approval = await prisma.adminActionApproval.create({
      data: {
        action: body.action,
        targetType: body.targetType,
        targetId: body.targetId || null,
        reason: body.reason,
        payload: payload as Prisma.InputJsonValue,
        payloadHash: approvalPayloadHash(payload),
        requestedById: session.user.id,
        requestedByEmail: session.user.email || null,
        expiresAt: new Date(
          Date.now() +
            approvalTtlMinutes(process.env.ADMIN_APPROVAL_TTL_MINUTES) * 60_000
        ),
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
    await consumeApiRateLimit(req, session.user.id, "admin-approvals-review", {
      minute: 12,
      day: 120,
    });

    const body = await readLimitedJson(req, 4 * 1024, reviewApprovalSchema);
    const existing = await prisma.adminActionApproval.findUnique({
      where: { id: body.approvalId },
    });
    if (!existing) {
      return NextResponse.json({ error: "Approval not found." }, { status: 404 });
    }
    if (!hasAdminPermission(session, approvalPermissionForAction(existing.action))) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }
    if (existing.requestedById === session.user.id) {
      return NextResponse.json(
        { error: "Administrators cannot approve or reject their own request." },
        { status: 409 }
      );
    }
    if (existing.status !== "pending") {
      return NextResponse.json(
        { error: `Approval is already ${existing.status}.` },
        { status: 409 }
      );
    }
    if (existing.expiresAt <= new Date()) {
      await prisma.adminActionApproval.updateMany({
        where: { id: existing.id, status: "pending" },
        data: { status: "expired" },
      });
      return NextResponse.json({ error: "Approval has expired." }, { status: 409 });
    }
    if (!canReviewAdminApproval({
      requestedById: existing.requestedById,
      reviewerId: session.user.id,
      status: existing.status,
      expiresAt: existing.expiresAt,
    })) {
      return NextResponse.json({ error: "Approval cannot be reviewed." }, { status: 409 });
    }
    await writeAdminAuditLog({
      session,
      request: req,
      action: "admin_approval.review_started",
      targetType: "AdminActionApproval",
      targetId: existing.id,
      summary: `Started ${body.status} review for ${existing.action}.`,
    });
    const reviewedAt = new Date();
    const updated = await prisma.adminActionApproval.updateMany({
      where: {
        id: existing.id,
        status: "pending",
        requestedById: { not: session.user.id },
        expiresAt: { gt: reviewedAt },
      },
      data: {
        status: body.status,
        reason: body.reason || undefined,
        reviewedAt,
        reviewedById: session.user.id,
        reviewedByEmail: session.user.email || null,
      },
    });
    if (updated.count !== 1) {
      return NextResponse.json(
        { error: "Approval changed while it was being reviewed." },
        { status: 409 }
      );
    }
    const approval = await prisma.adminActionApproval.findUniqueOrThrow({
      where: { id: existing.id },
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
