export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { isAdminSession } from "@/lib/adminAuth";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
} from "@/lib/apiSecurity";
import { prisma } from "@/lib/prisma";

const daysAgo = (days: number) =>
  new Date(Date.now() - days * 24 * 60 * 60 * 1000);

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

    const usageCutoff = daysAgo(120);
    const leaseCutoff = new Date();
    const revokedShareCutoff = daysAgo(30);
    const auditCutoff = daysAgo(365);
    const notificationCutoff = daysAgo(90);
    const providerCheckCutoff = daysAgo(30);
    const providerErrorCutoff = daysAgo(30);
    const productAnalyticsCutoff = daysAgo(400);

    const [
      oldUsageBuckets,
      expiredLeases,
      staleShares,
      oldAuditLogs,
      oldNotificationLogs,
      oldProviderChecks,
      oldProviderErrors,
      oldProductAnalytics,
      oldestUsage,
      oldestLease,
      oldestShare,
      oldestAudit,
      oldestNotification,
      oldestProviderCheck,
      oldestProviderError,
      oldestProductAnalytics,
    ] = await Promise.all([
      prisma.chatUsageBucket.count({ where: { updatedAt: { lt: usageCutoff } } }),
      prisma.chatRequestLease.count({ where: { expiresAt: { lt: leaseCutoff } } }),
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
        where: { createdAt: { lt: notificationCutoff } },
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
    ]);

    return NextResponse.json({
      generatedAt: new Date().toISOString(),
      items: [
        {
          key: "usageBuckets",
          label: "Usage buckets",
          policy: "Delete buckets older than 120 days.",
          staleCount: oldUsageBuckets,
          oldestAt: oldestUsage,
        },
        {
          key: "requestLeases",
          label: "Request leases",
          policy: "Delete expired request leases.",
          staleCount: expiredLeases,
          oldestAt: oldestLease,
        },
        {
          key: "shareSnapshots",
          label: "Share snapshots",
          policy: "Clear expired or revoked share snapshots.",
          staleCount: staleShares,
          oldestAt: oldestShare,
        },
        {
          key: "auditLogs",
          label: "Audit logs",
          policy: "Keep admin audit logs for at least 365 days.",
          staleCount: oldAuditLogs,
          oldestAt: oldestAudit,
        },
        {
          key: "notificationLogs",
          label: "Notification logs",
          policy: "Delete alert delivery logs older than 90 days.",
          staleCount: oldNotificationLogs,
          oldestAt: oldestNotification,
        },
        {
          key: "providerChecks",
          label: "Provider checks",
          policy: "Delete manual provider check records older than 30 days.",
          staleCount: oldProviderChecks,
          oldestAt: oldestProviderCheck,
        },
        {
          key: "providerErrors",
          label: "Provider error events",
          policy: "Delete sanitized provider error diagnostics older than 30 days.",
          staleCount: oldProviderErrors,
          oldestAt: oldestProviderError,
        },
        {
          key: "productAnalytics",
          label: "Product analytics events",
          policy: "Delete consented, pseudonymous product events older than 400 days.",
          staleCount: oldProductAnalytics,
          oldestAt: oldestProductAnalytics,
        },
      ],
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
