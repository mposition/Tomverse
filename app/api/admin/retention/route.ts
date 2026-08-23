export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { isAdminSession } from "@/lib/adminAuth";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
} from "@/lib/apiSecurity";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  DEFAULT_SNAPSHOT_RETENTION_DAYS,
  SNAPSHOT_RETENTION_DAYS,
} from "@/lib/emailSnapshotRetentionCore";
import { retentionCutoff, retentionPolicy } from "@/lib/retentionPolicyCore";

/**
 * What each policy currently has waiting for it.
 *
 * The sentences and the windows are not written here: they come from
 * lib/retentionPolicyCore.ts, which the maintenance sweep also reads. This
 * screen used to carry its own copy of both, and two of the nine policies it
 * published were performed by nothing -- the count climbed, an operator ran
 * the cleanup, and the number stayed exactly where it was.
 */
const oldestDate = async <T extends { createdAt?: Date; updatedAt?: Date }>(
  loader: () => Promise<T | null>,
  field: "createdAt" | "updatedAt"
) => {
  const row = await loader();
  return row?.[field]?.toISOString() || null;
};

export async function GET(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }

    await consumeApiRateLimit(req, session.user.id, "admin-retention-read", {
      minute: 30,
      day: 500,
    });

    const now = new Date();
    const usageCutoff = retentionCutoff("usageBuckets", now);
    const leaseCutoff = now;
    const revokedShareCutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const auditCutoff = retentionCutoff("auditLogs", now);
    const notificationCutoff = retentionCutoff("notificationLogs", now);
    const providerCheckCutoff = retentionCutoff("providerChecks", now);
    const providerErrorCutoff = retentionCutoff("providerErrors", now);
    const emailLoginCutoff = retentionCutoff("emailLoginAttempts", now);
    const deepResearchCutoff = retentionCutoff("deepResearchJobs", now);
    const storageCleanupCutoff = retentionCutoff("storageCleanupQueues", now);
    const shadowSampleCutoff = retentionCutoff("tokenEstimateShadowSamples", now);
    const productAnalyticsCutoff = retentionCutoff("productAnalytics", now);

    const [
      oldUsageBuckets,
      expiredLeases,
      expiredCreditReservations,
      staleShares,
      oldAuditLogs,
      oldNotificationLogs,
      oldEmailLoginAttempts,
      oldDeepResearchJobs,
      oldImageCleanups,
      oldKnowledgeCleanups,
      oldShadowSamples,
      oldProviderChecks,
      oldProviderErrors,
      oldProductAnalytics,
      oldProbeResults,
      oldJobRuns,
      oldCatalogRuns,
      oldestProbeResult,
      oldestJobRun,
      oldestCatalogRun,
      oldestUsage,
      oldestLease,
      oldestCreditReservation,
      oldestShare,
      oldestAudit,
      oldestNotification,
      oldestEmailLoginAttempt,
      oldestDeepResearchJob,
      oldestStorageCleanup,
      oldestShadowSample,
      oldestProviderCheck,
      oldestProviderError,
      oldestProductAnalytics,
      staleSnapshots,
      oldestSnapshot,
    ] = await Promise.all([
      prisma.chatUsageBucket.count({ where: { updatedAt: { lt: usageCutoff } } }),
      prisma.chatRequestLease.count({ where: { expiresAt: { lt: leaseCutoff } } }),
      prisma.chatCreditReservation.count({
        where: { status: "reserved", expiresAt: { lt: leaseCutoff } },
      }),
      prisma.conversation.count({
        where: {
          OR: [
            { shareExpiresAt: { lt: leaseCutoff } },
            { shareRevokedAt: { lt: revokedShareCutoff } },
          ],
        },
      }),
      prisma.adminAuditLog.count({ where: { createdAt: { lt: auditCutoff } } }),
      prisma.adminNotificationLog.count({
        // Same carve-out the sweep applies. Counting the rows it will not take
        // is how a screen reports work that never finishes.
        where: {
          createdAt: { lt: notificationCutoff },
          NOT: { status: "failed", acknowledgedAt: null },
        },
      }),
      prisma.emailLoginAttempt.count({
        // `expiresAt`, matching the sweep. Counting by `createdAt` would
        // report a number the cleanup does not take.
        where: { expiresAt: { lt: emailLoginCutoff } },
      }),
      prisma.perplexityAsyncJob.count({
        where: { updatedAt: { lt: deepResearchCutoff } },
      }),
      prisma.imageAssetCleanup.count({
        where: { completedAt: { not: null, lt: storageCleanupCutoff } },
      }),
      prisma.assistantKnowledgeCleanup.count({
        where: { completedAt: { not: null, lt: storageCleanupCutoff } },
      }),
      prisma.tokenEstimateShadowSample.count({
        where: { createdAt: { lt: shadowSampleCutoff } },
      }),
      prisma.providerHealthCheck.count({
        where: { createdAt: { lt: providerCheckCutoff } },
      }),
      prisma.providerErrorEvent.count({
        where: { createdAt: { lt: providerErrorCutoff } },
      }),
      prisma.productAnalyticsEvent.count({
        where: { occurredAt: { lt: productAnalyticsCutoff } },
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
      prisma.providerProbeResult
        .findFirst({ orderBy: { startedAt: "asc" }, select: { startedAt: true } })
        .then((row) => row?.startedAt.toISOString() || null),
      prisma.scheduledJobRun
        .findFirst({ orderBy: { startedAt: "asc" }, select: { startedAt: true } })
        .then((row) => row?.startedAt.toISOString() || null),
      prisma.providerModelCatalogRun
        .findFirst({ orderBy: { startedAt: "asc" }, select: { startedAt: true } })
        .then((row) => row?.startedAt.toISOString() || null),
      oldestDate(
        () =>
          prisma.chatUsageBucket.findFirst({
            orderBy: { updatedAt: "asc" },
            select: { updatedAt: true },
          }),
        "updatedAt"
      ),
      oldestDate(
        () =>
          prisma.chatRequestLease.findFirst({
            orderBy: { createdAt: "asc" },
            select: { createdAt: true },
          }),
        "createdAt"
      ),
      prisma.chatCreditReservation
        .findFirst({
          where: { status: "reserved", expiresAt: { lt: leaseCutoff } },
          orderBy: { expiresAt: "asc" },
          select: { expiresAt: true },
        })
        .then((row) => row?.expiresAt.toISOString() || null),
      oldestDate(
        () =>
          prisma.conversation.findFirst({
            where: { shareEnabled: true },
            orderBy: { sharedAt: "asc" },
            select: { createdAt: true },
          }),
        "createdAt"
      ),
      oldestDate(
        () =>
          prisma.adminAuditLog.findFirst({
            orderBy: { createdAt: "asc" },
            select: { createdAt: true },
          }),
        "createdAt"
      ),
      oldestDate(
        () =>
          prisma.adminNotificationLog.findFirst({
            orderBy: { createdAt: "asc" },
            select: { createdAt: true },
          }),
        "createdAt"
      ),
      oldestDate(
        () =>
          prisma.providerHealthCheck.findFirst({
            orderBy: { createdAt: "asc" },
            select: { createdAt: true },
          }),
        "createdAt"
      ),
      prisma.emailLoginAttempt
        .findFirst({
          orderBy: { expiresAt: "asc" },
          select: { expiresAt: true },
        })
        .then((row) => row?.expiresAt.toISOString() || null),
      prisma.perplexityAsyncJob
        .findFirst({
          orderBy: { updatedAt: "asc" },
          select: { updatedAt: true },
        })
        .then((row) => row?.updatedAt.toISOString() || null),
      // The older of the two queues' oldest completed rows: one policy, one
      // number, so the screen cannot report a date for a queue it is not
      // naming.
      Promise.all([
        prisma.imageAssetCleanup.findFirst({
          where: { completedAt: { not: null } },
          orderBy: { completedAt: "asc" },
          select: { completedAt: true },
        }),
        prisma.assistantKnowledgeCleanup.findFirst({
          where: { completedAt: { not: null } },
          orderBy: { completedAt: "asc" },
          select: { completedAt: true },
        }),
      ]).then(([image, knowledge]) => {
        const dates = [image?.completedAt, knowledge?.completedAt].filter(
          (value): value is Date => Boolean(value)
        );
        if (dates.length === 0) return null;
        return new Date(Math.min(...dates.map((date) => date.getTime()))).toISOString();
      }),
      prisma.tokenEstimateShadowSample
        .findFirst({ orderBy: { createdAt: "asc" }, select: { createdAt: true } })
        .then((row) => row?.createdAt.toISOString() || null),
      oldestDate(
        () =>
          prisma.providerErrorEvent.findFirst({
            orderBy: { createdAt: "asc" },
            select: { createdAt: true },
          }),
        "createdAt"
      ),
      prisma.productAnalyticsEvent
        .findFirst({
          orderBy: { occurredAt: "asc" },
          select: { occurredAt: true },
        })
        .then((row) => row?.occurredAt.toISOString() || null),
      // Per classification, because the window is per classification: counting
      // every snapshot older than 90 days would report legal notices as
      // overdue for six and a half years before the sweep would touch them.
      prisma
        .$queryRaw<Array<{ count: bigint }>>`
          SELECT COUNT(*)::bigint AS count
            FROM "EmailDelivery" AS d
            JOIN "TemplateVersion" AS v ON v."id" = d."templateVersionId"
            JOIN "EmailTemplate" AS t ON t."id" = v."templateId"
           WHERE d."renderDataSnapshot" IS NOT NULL
             AND COALESCE(d."sentAt", d."createdAt")
                   < NOW() - make_interval(days => CASE t."classification"
                       WHEN 'legal' THEN ${SNAPSHOT_RETENTION_DAYS.legal}
                       ELSE ${DEFAULT_SNAPSHOT_RETENTION_DAYS} END)
        `
        .then((rows) => Number(rows[0]?.count ?? 0)),
      prisma.emailDelivery
        .findFirst({
          where: { renderDataSnapshot: { not: Prisma.JsonNull } },
          orderBy: { createdAt: "asc" },
          select: { createdAt: true },
        })
        .then((row) => row?.createdAt.toISOString() || null),
    ]);

    const measured: Record<
      string,
      { staleCount: number; oldestAt: string | null }
    > = {
      usageBuckets: { staleCount: oldUsageBuckets, oldestAt: oldestUsage },
      requestLeases: { staleCount: expiredLeases, oldestAt: oldestLease },
      creditReservations: {
        staleCount: expiredCreditReservations,
        oldestAt: oldestCreditReservation,
      },
      shareSnapshots: { staleCount: staleShares, oldestAt: oldestShare },
      auditLogs: { staleCount: oldAuditLogs, oldestAt: oldestAudit },
      notificationLogs: {
        staleCount: oldNotificationLogs,
        oldestAt: oldestNotification,
      },
      emailLoginAttempts: {
        staleCount: oldEmailLoginAttempts,
        oldestAt: oldestEmailLoginAttempt,
      },
      deepResearchJobs: {
        staleCount: oldDeepResearchJobs,
        oldestAt: oldestDeepResearchJob,
      },
      storageCleanupQueues: {
        staleCount: oldImageCleanups + oldKnowledgeCleanups,
        oldestAt: oldestStorageCleanup,
      },
      tokenEstimateShadowSamples: {
        staleCount: oldShadowSamples,
        oldestAt: oldestShadowSample,
      },
      providerChecks: {
        staleCount: oldProviderChecks,
        oldestAt: oldestProviderCheck,
      },
      providerErrors: {
        staleCount: oldProviderErrors,
        oldestAt: oldestProviderError,
      },
      productAnalytics: {
        staleCount: oldProductAnalytics,
        oldestAt: oldestProductAnalytics,
      },
      providerProbeResults: {
        staleCount: oldProbeResults,
        oldestAt: oldestProbeResult,
      },
      scheduledJobRuns: { staleCount: oldJobRuns, oldestAt: oldestJobRun },
      providerModelCatalogRuns: {
        staleCount: oldCatalogRuns,
        oldestAt: oldestCatalogRun,
      },
      emailDeliverySnapshots: {
        staleCount: staleSnapshots,
        oldestAt: oldestSnapshot,
      },
    };

    return NextResponse.json({
      generatedAt: now.toISOString(),
      items: Object.keys(measured).map((key) => {
        const { label, policy, action } = retentionPolicy(key);
        return { key, label, policy, action, ...measured[key] };
      }),
    });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Failed to load retention status:", error);
    return NextResponse.json(
      { error: "Failed to load retention status." },
      { status: 500 }
    );
  }
}
