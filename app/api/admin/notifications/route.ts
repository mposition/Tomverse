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

export async function GET(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }

    await consumeApiRateLimit(req, session.user.id, "admin-notifications-read", {
      minute: 30,
      day: 500,
    });

    const url = new URL(req.url);
    const take = Math.min(
      Math.max(Math.trunc(Number(url.searchParams.get("take") || 20)), 1),
      50
    );
    const cursor = (url.searchParams.get("cursor") || "").trim() || null;
    const requestedStatus = (url.searchParams.get("status") || "all").trim();
    const status = ["sent", "failed", "skipped"].includes(requestedStatus)
      ? requestedStatus
      : null;
    const where = status ? { status } : {};
    const [records, statusGroups, unacknowledgedCount, totalCount, filteredCount] =
      await Promise.all([
        prisma.adminNotificationLog.findMany({
          where,
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: take + 1,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        }),
        prisma.adminNotificationLog.groupBy({
          by: ["status"],
          _count: { _all: true },
        }),
        prisma.adminNotificationLog.count({
          where: { status: "failed", acknowledgedAt: null },
        }),
        prisma.adminNotificationLog.count(),
        status
          ? prisma.adminNotificationLog.count({ where: { status } })
          : prisma.adminNotificationLog.count(),
      ]);
    const hasMore = records.length > take;
    const logs = hasMore ? records.slice(0, take) : records;
    const statusCounts = Object.fromEntries(
      statusGroups.map((group) => [group.status, group._count._all])
    );

    return NextResponse.json({
      logs: logs.map((log) => ({
        ...log,
        createdAt: log.createdAt.toISOString(),
      })),
      nextCursor: hasMore ? logs.at(-1)?.id || null : null,
      pageSize: take,
      filteredCount,
      stats: {
        total: totalCount,
        sent: statusCounts.sent || 0,
        failed: statusCounts.failed || 0,
        skipped: statusCounts.skipped || 0,
        unacknowledged: unacknowledgedCount,
      },
    });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Failed to load admin notification logs:", error);
    return NextResponse.json({ error: "Failed to load notification logs." }, { status: 500 });
  }
}
