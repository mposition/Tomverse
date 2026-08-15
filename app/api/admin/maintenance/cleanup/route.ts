export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { z } from "zod";
import { authOptions } from "@/lib/auth";
import {
  adminApprovalErrorResponse,
  runWithAdminApproval,
} from "@/lib/adminApproval";
import { hasAdminPermission, isAdminSession } from "@/lib/adminAuth";
import { writeAdminAuditLog } from "@/lib/adminAudit";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
  readLimitedJson,
} from "@/lib/apiSecurity";
import { cleanupExpiredData } from "@/lib/maintenance";
import { summarizeMaintenanceStepFailures } from "@/lib/maintenanceStepsCore";
import { prisma } from "@/lib/prisma";
import { retentionCutoff } from "@/lib/retentionPolicyCore";

const cleanupSchema = z
  .object({
    mode: z.enum(["dry-run", "execute"]),
    confirmText: z.string().trim().max(64).optional(),
  })
  .strict();

async function dryRunCleanup() {
  const now = new Date();
  // Cutoffs come from the published policy rather than a literal, so a dry run
  // cannot promise a different date from the one the execution uses.
  const [
    sessions,
    usageBuckets,
    requestLeases,
    creditReservations,
    emailLoginAttempts,
    deepResearchJobs,
    providerErrorEvents,
    providerHealthChecks,
    providerProbeResults,
    scheduledJobRuns,
    providerModelCatalogRuns,
    notificationLogs,
    productAnalyticsEvents,
    shareSnapshots,
  ] = await Promise.all([
    prisma.session.count({ where: { expires: { lte: now } } }),
    prisma.chatUsageBucket.count({
      where: { updatedAt: { lt: retentionCutoff("usageBuckets", now) } },
    }),
    prisma.chatRequestLease.count({ where: { expiresAt: { lte: now } } }),
    prisma.chatCreditReservation.count({
      where: { status: "reserved", expiresAt: { lte: now } },
    }),
    prisma.emailLoginAttempt.count({
      where: {
        expiresAt: { lt: retentionCutoff("emailLoginAttempts", now) },
      },
    }),
    prisma.perplexityAsyncJob.count({
      where: { updatedAt: { lt: retentionCutoff("deepResearchJobs", now) } },
    }),
    prisma.providerErrorEvent.count({
      where: { createdAt: { lt: retentionCutoff("providerErrors", now) } },
    }),
    prisma.providerHealthCheck.count({
      where: { createdAt: { lt: retentionCutoff("providerChecks", now) } },
    }),
    prisma.providerProbeResult.count({
      where: { startedAt: { lt: retentionCutoff("providerProbeResults", now) } },
    }),
    prisma.scheduledJobRun.count({
      where: { startedAt: { lt: retentionCutoff("scheduledJobRuns", now) } },
    }),
    prisma.providerModelCatalogRun.count({
      where: {
        startedAt: { lt: retentionCutoff("providerModelCatalogRuns", now) },
      },
    }),
    prisma.adminNotificationLog.count({
      where: {
        createdAt: { lt: retentionCutoff("notificationLogs", now) },
        NOT: { status: "failed", acknowledgedAt: null },
      },
    }),
    prisma.productAnalyticsEvent.count({
      where: { occurredAt: { lt: retentionCutoff("productAnalytics", now) } },
    }),
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
  return {
    sessions,
    usageBuckets,
    requestLeases,
    creditReservations,
    emailLoginAttempts,
    deepResearchJobs,
    providerErrorEvents,
    providerHealthChecks,
    providerProbeResults,
    scheduledJobRuns,
    providerModelCatalogRuns,
    notificationLogs,
    productAnalyticsEvents,
    shareSnapshots,
  };
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

    const result =
      body.mode === "execute"
        ? await runWithAdminApproval(
            {
              session,
              request: req,
              action: "retention.cleanup.execute",
              targetType: "Retention",
              targetId: "expired-data",
              payload: body,
              reason: "Execute destructive retention cleanup.",
            },
            cleanupExpiredData
          )
        : await dryRunCleanup();
    // An execution whose steps run in isolation can finish with some of them
    // failed. Recording that as "completed" would tell the operator who typed
    // RUN CLEANUP that the sweep ran, when part of it did not.
    const failedSteps =
      "failedSteps" in result ? result.failedSteps : [];
    const run = await prisma.adminRetentionRun.create({
      data: {
        mode: body.mode,
        status: failedSteps.length > 0 ? "partial" : "completed",
        result,
        error:
          failedSteps.length > 0
            ? summarizeMaintenanceStepFailures(failedSteps).slice(0, 1_000)
            : null,
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
    const approvalResponse = adminApprovalErrorResponse(error);
    if (approvalResponse) return approvalResponse;
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
