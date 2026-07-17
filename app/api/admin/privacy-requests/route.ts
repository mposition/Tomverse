export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";
import { z } from "zod";
import { authOptions } from "@/lib/auth";
import { writeAdminAuditLog } from "@/lib/adminAudit";
import { hasAdminPermission, isAdminSession } from "@/lib/adminAuth";
import { apiSecurityResponse, consumeApiRateLimit, readLimitedJson } from "@/lib/apiSecurity";
import { prisma } from "@/lib/prisma";

const createSchema = z.object({
  email: z.string().trim().email().max(320),
  userId: z.string().trim().max(120).nullable().optional(),
  requestType: z.enum(["access", "export", "deletion", "correction"]),
  dueAt: z.string().datetime(),
  note: z.string().trim().max(2_000).nullable().optional(),
}).strict();

const updateSchema = z.object({
  id: z.string().trim().min(5).max(120),
  status: z.enum(["open", "in_progress", "completed", "rejected"]),
  dueAt: z.string().datetime(),
  legalHold: z.boolean(),
  legalHoldReason: z.string().trim().max(2_000).nullable(),
  note: z.string().trim().max(2_000).nullable(),
}).strict().superRefine((value, context) => {
  if (value.legalHold && (!value.legalHoldReason || value.legalHoldReason.length < 5)) {
    context.addIssue({
      code: "custom",
      path: ["legalHoldReason"],
      message: "A legal hold reason is required.",
    });
  }
});

const serialize = (row: {
  id: string; userId: string | null; email: string; requestType: string;
  status: string; dueAt: Date; legalHold: boolean; legalHoldReason: string | null;
  note: string | null; completedAt: Date | null; handledByEmail: string | null;
  createdAt: Date; updatedAt: Date;
}) => ({
  ...row,
  dueAt: row.dueAt.toISOString(),
  completedAt: row.completedAt?.toISOString() || null,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

export async function GET(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    await consumeApiRateLimit(req, session.user.id, "admin-privacy-requests-read", {
      minute: 30,
      day: 1_000,
    });
    const url = new URL(req.url);
    const cursor = url.searchParams.get("cursor");
    const status = url.searchParams.get("status");
    const take = Math.min(50, Math.max(10, Number(url.searchParams.get("take")) || 30));
    const rows = await prisma.privacyRequest.findMany({
      where: status && status !== "all" ? { status } : undefined,
      orderBy: [{ dueAt: "asc" }, { id: "asc" }],
      take: take + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > take;
    const page = hasMore ? rows.slice(0, take) : rows;
    return NextResponse.json({
      requests: page.map(serialize),
      nextCursor: hasMore ? page.at(-1)?.id || null : null,
    });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Privacy request queue load failed:", error);
    return NextResponse.json({ error: "Failed to load privacy request queue." }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    if (!hasAdminPermission(session, "support:write")) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }
    await consumeApiRateLimit(req, session.user.id, "admin-privacy-requests-create", {
      minute: 10,
      day: 100,
    });
    const body = await readLimitedJson(req, 8 * 1024, createSchema);
    const user = body.userId
      ? await prisma.user.findUnique({ where: { id: body.userId }, select: { id: true, email: true } })
      : await prisma.user.findUnique({ where: { email: body.email }, select: { id: true, email: true } });
    if (body.userId && !user) {
      return NextResponse.json({ error: "User not found." }, { status: 404 });
    }
    const privacyRequest = await prisma.privacyRequest.create({
      data: {
        userId: user?.id || null,
        email: user?.email || body.email.toLowerCase(),
        requestType: body.requestType,
        dueAt: new Date(body.dueAt),
        note: body.note || null,
        handledById: session.user.id,
        handledByEmail: session.user.email || null,
      },
    });
    await writeAdminAuditLog({
      session,
      request: req,
      action: "privacy_request.created",
      targetType: "PrivacyRequest",
      targetId: privacyRequest.id,
      summary: `Created ${privacyRequest.requestType} privacy request for ${privacyRequest.email}.`,
      metadata: { userId: privacyRequest.userId, dueAt: privacyRequest.dueAt.toISOString() },
    });
    return NextResponse.json({ request: serialize(privacyRequest) });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Privacy request creation failed:", error);
    return NextResponse.json({ error: "Failed to create privacy request." }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    if (!hasAdminPermission(session, "support:write")) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }
    await consumeApiRateLimit(req, session.user.id, "admin-privacy-requests-update", {
      minute: 20,
      day: 300,
    });
    const body = await readLimitedJson(req, 8 * 1024, updateSchema);
    const privacyRequest = await prisma.privacyRequest.update({
      where: { id: body.id },
      data: {
        status: body.status,
        dueAt: new Date(body.dueAt),
        legalHold: body.legalHold,
        legalHoldReason: body.legalHold ? body.legalHoldReason : null,
        note: body.note,
        completedAt: body.status === "completed" ? new Date() : null,
        handledById: session.user.id,
        handledByEmail: session.user.email || null,
      },
    });
    await writeAdminAuditLog({
      session,
      request: req,
      action: "privacy_request.updated",
      targetType: "PrivacyRequest",
      targetId: privacyRequest.id,
      summary: `Changed privacy request to ${privacyRequest.status}${privacyRequest.legalHold ? " with legal hold" : ""}.`,
      metadata: {
        dueAt: privacyRequest.dueAt.toISOString(),
        legalHold: privacyRequest.legalHold,
      },
    });
    return NextResponse.json({ request: serialize(privacyRequest) });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Privacy request update failed:", error);
    return NextResponse.json({ error: "Failed to update privacy request." }, { status: 500 });
  }
}
