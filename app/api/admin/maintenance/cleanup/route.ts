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
import { cleanupExpiredData } from "@/lib/maintenance";
import { prisma } from "@/lib/prisma";

const cleanupSchema = z
  .object({
    mode: z.enum(["dry-run", "execute"]),
    confirmText: z.string().trim().max(64).optional(),
  })
  .strict();

async function dryRunCleanup() {
  const now = new Date();
  const usageCutoff = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000);
  const providerErrorCutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const [sessions, usageBuckets, requestLeases, providerErrorEvents, shareSnapshots] = await Promise.all([
    prisma.session.count({ where: { expires: { lte: now } } }),
    prisma.chatUsageBucket.count({ where: { updatedAt: { lt: usageCutoff } } }),
    prisma.chatRequestLease.count({ where: { expiresAt: { lte: now } } }),
    prisma.providerErrorEvent.count({ where: { createdAt: { lt: providerErrorCutoff } } }),
    prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*)::bigint AS "count"
      FROM "Conversation"
      WHERE
        (
          "shareExpiresAt" <= NOW()
          OR "shareRevokedAt" IS NOT NULL
          OR "shareEnabled" = FALSE
        )
        AND (
          "shareToken" IS NOT NULL
          OR "shareSnapshot" IS NOT NULL
          OR "shareExpiresAt" IS NOT NULL
        )
    `.then((rows) => Number(rows[0]?.count || 0)),
  ]);
  return { sessions, usageBuckets, requestLeases, providerErrorEvents, shareSnapshots };
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

    await consumeApiRateLimit(req, session.user.id, "admin-cleanup-run", {
      minute: 6,
      day: 40,
    });

    const body = await readLimitedJson(req, 2 * 1024, cleanupSchema);
    if (body.mode === "execute" && body.confirmText !== "RUN CLEANUP") {
      return NextResponse.json(
        { error: "Type RUN CLEANUP to execute cleanup." },
        { status: 400 }
      );
    }

    const result = body.mode === "execute" ? await cleanupExpiredData() : await dryRunCleanup();
    const run = await prisma.adminRetentionRun.create({
      data: {
        mode: body.mode,
        status: "completed",
        result,
        createdById: session.user.id,
        createdByEmail: session.user.email || null,
      },
    });

    await writeAdminAuditLog({
      session,
      request: req,
      action: body.mode === "execute" ? "retention.cleanup.executed" : "retention.cleanup.dry_run",
      targetType: "Retention",
      targetId: run.id,
      summary: body.mode === "execute" ? "Executed retention cleanup." : "Ran retention cleanup dry run.",
      metadata: result,
    });

    return NextResponse.json({ success: true, run });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Admin cleanup run failed:", error);
    const run = await prisma.adminRetentionRun.create({
      data: {
        mode: "unknown",
        status: "failed",
        error: error instanceof Error ? error.message.slice(0, 1_000) : "Unknown cleanup error.",
      },
    }).catch(() => null);
    return NextResponse.json(
      { error: "Cleanup run failed.", run },
      { status: 500 }
    );
  }
}
