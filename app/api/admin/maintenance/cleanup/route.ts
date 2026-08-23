export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { z } from "zod";
import { authOptions } from "@/lib/auth";
import {
  adminApprovalErrorResponse,
  runWithAdminApproval,
} from "@/lib/adminApproval";
import { approvalPayloadHash } from "@/lib/adminApprovalCore";
import {
  adminSoleApproverErrorResponse,
  runAsSoleApprover,
  soleApproverIsAvailable,
} from "@/lib/adminSoleApproverExecution";
import { hasAdminPermission, isAdminSession } from "@/lib/adminAuth";
import { writeAdminAuditLog } from "@/lib/adminAudit";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
  readLimitedJson,
} from "@/lib/apiSecurity";
import { readKnowledgeCleanupQueueDryRun } from "@/lib/assistantKnowledgeLifecycle";
import { cleanupExpiredData } from "@/lib/maintenance";
import { summarizeMaintenanceStepFailures } from "@/lib/maintenanceStepsCore";
import { prisma } from "@/lib/prisma";
import { retentionCutoff } from "@/lib/retentionPolicyCore";

// `.strict()` is load-bearing rather than tidy: `cleanupExpiredData()` takes
// no arguments and reads every cutoff from `lib/retentionPolicyCore.ts`, so
// there is no parameter through which a caller could widen what gets deleted.
// Refusing unknown keys here is what keeps it that way when somebody adds one
// (condition 4, lib/adminSoleApproverCore.ts).
const cleanupSchema = z
  .object({
    mode: z.enum(["dry-run", "execute"]),
    confirmText: z.string().trim().max(64).optional(),
    // Echoed back from the dry run being confirmed. Only the sole-approver
    // path reads them; with two administrators configured the ordinary
    // approval applies and these are ignored.
    dryRunId: z.string().trim().min(1).max(64).optional(),
    dryRunDigest: z.string().trim().regex(/^[0-9a-f]{64}$/).optional(),
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
    storageCleanupQueues,
    tokenEstimateShadowSamples,
    providerErrorEvents,
    providerHealthChecks,
    providerProbeResults,
    scheduledJobRuns,
    providerModelCatalogRuns,
    notificationLogs,
    productAnalyticsEvents,
    shareSnapshots,
    assistantKnowledge,
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
    Promise.all([
      prisma.imageAssetCleanup.count({
        where: {
          completedAt: {
            not: null,
            lt: retentionCutoff("storageCleanupQueues", now),
          },
        },
      }),
      prisma.assistantKnowledgeCleanup.count({
        where: {
          completedAt: {
            not: null,
            lt: retentionCutoff("storageCleanupQueues", now),
          },
        },
      }),
    ]).then(([images, knowledge]) => images + knowledge),
    prisma.tokenEstimateShadowSample.count({
      where: {
        createdAt: { lt: retentionCutoff("tokenEstimateShadowSamples", now) },
      },
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
    // `storageCleanupQueues` above is a different question and stays: it counts
    // cleanup rows being garbage-collected long after their bytes went, and it
    // merges images with knowledge. What an operator needs before typing RUN
    // CLEANUP is how many objects this run will delete from R2 and whether
    // anything is stuck, which is what this reports
    // (lib/assistantKnowledgeCleanupDryRunCore.ts).
    readKnowledgeCleanupQueueDryRun(),
  ]);
  return {
    sessions,
    usageBuckets,
    requestLeases,
    creditReservations,
    emailLoginAttempts,
    deepResearchJobs,
    storageCleanupQueues,
    tokenEstimateShadowSamples,
    providerErrorEvents,
    providerHealthChecks,
    providerProbeResults,
    scheduledJobRuns,
    providerModelCatalogRuns,
    notificationLogs,
    productAnalyticsEvents,
    shareSnapshots,
    assistantKnowledge,
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

    // A single-administrator organisation cannot satisfy
    // `requestedById !== reviewerId`, so `retention.cleanup.execute` -- the
    // recovery path for a sweep that has fallen behind -- was unreachable for
    // it. The exception is scoped to this action and bound to the dry run the
    // operator just looked at (lib/adminSoleApproverCore.ts). With a second
    // administrator configured this condition is false and the ordinary
    // two-person path runs, which is condition 6 needing no migration.
    // Not conditioned on the binding being present: with one administrator
    // this is the only path there is, so an execution that skipped the dry run
    // must be told to run one rather than fall through to an approval nobody
    // can grant.
    const asSoleApprover =
      body.mode === "execute" &&
      soleApproverIsAvailable("retention.cleanup.execute", session);

    const result =
      body.mode !== "execute"
        ? await dryRunCleanup()
        : asSoleApprover
          ? await runAsSoleApprover(
              {
                session,
                request: req,
                action: "retention.cleanup.execute",
                targetType: "Retention",
                targetId: "expired-data",
                submittedRunId: body.dryRunId || "",
                submittedDigest: body.dryRunDigest || "",
              },
              cleanupExpiredData
            )
          : await runWithAdminApproval(
              {
                session,
                request: req,
                action: "retention.cleanup.execute",
                targetType: "Retention",
                targetId: "expired-data",
                // Deliberately not `body`. The approval is matched by this
                // hash, and the retry that follows a second administrator's
                // approval carries whatever dry run is current by then --
                // including the binding would make every retry look like a
                // new request and consume no approval at all.
                payload: { mode: body.mode, confirmText: body.confirmText },
                reason: "Execute destructive retention cleanup.",
              },
              cleanupExpiredData
            );
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

    // Hashed from the stored row rather than the in-memory result, because
    // that is the value the execution reads back when it checks the binding.
    return NextResponse.json({
      success: true,
      run,
      resultDigest: approvalPayloadHash(run.result),
    });
  } catch (error) {
    const approvalResponse = adminApprovalErrorResponse(error);
    if (approvalResponse) return approvalResponse;
    const soleApproverResponse = adminSoleApproverErrorResponse(error);
    if (soleApproverResponse) return soleApproverResponse;
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
