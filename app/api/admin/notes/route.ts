export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import type { Session } from "next-auth";
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

const targetTypes = ["User", "RefundRequest", "Feedback", "BillingConfig", "Model"] as const;

const createNoteSchema = z
  .object({
    targetType: z.enum(targetTypes),
    targetId: z.string().trim().min(1).max(160),
    body: z.string().trim().min(1).max(2_000),
  })
  .strict();

const canWriteNote = (session: Session | null) =>
  hasAdminPermission(session, "support:write") ||
  hasAdminPermission(session, "billing:write") ||
  hasAdminPermission(session, "ops:write");

export async function GET(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }

    await consumeApiRateLimit(req, session.user.id, "admin-notes-read", {
      minute: 60,
      day: 1_000,
    });

    const url = new URL(req.url);
    const targetType = url.searchParams.get("targetType") || "";
    const targetId = url.searchParams.get("targetId") || "";
    if (!targetTypes.includes(targetType as (typeof targetTypes)[number]) || !targetId) {
      return NextResponse.json({ error: "Invalid note target." }, { status: 400 });
    }

    const notes = await prisma.adminNote.findMany({
      where: { targetType, targetId },
      orderBy: { createdAt: "desc" },
      take: 20,
    });

    return NextResponse.json({
      notes: notes.map((note) => ({
        ...note,
        createdAt: note.createdAt.toISOString(),
        updatedAt: note.updatedAt.toISOString(),
      })),
    });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Failed to load admin notes:", error);
    return NextResponse.json({ error: "Failed to load notes." }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    if (!canWriteNote(session)) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }

    await consumeApiRateLimit(req, session.user.id, "admin-notes-write", {
      minute: 20,
      day: 300,
    });

    const body = await readLimitedJson(req, 4 * 1024, createNoteSchema);
    const note = await prisma.adminNote.create({
      data: {
        targetType: body.targetType,
        targetId: body.targetId,
        body: body.body,
        createdById: session.user.id,
        createdByEmail: session.user.email || null,
      },
    });

    await writeAdminAuditLog({
      session,
      request: req,
      action: "admin.note.created",
      targetType: body.targetType,
      targetId: body.targetId,
      summary: `Added admin note to ${body.targetType} ${body.targetId}.`,
    });

    return NextResponse.json({
      note: {
        ...note,
        createdAt: note.createdAt.toISOString(),
        updatedAt: note.updatedAt.toISOString(),
      },
    });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Failed to create admin note:", error);
    return NextResponse.json({ error: "Failed to save note." }, { status: 500 });
  }
}
