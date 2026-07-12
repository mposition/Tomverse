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
    const take = Math.min(Math.max(Number(url.searchParams.get("take") || 50), 1), 100);
    const logs = await prisma.adminNotificationLog.findMany({
      orderBy: { createdAt: "desc" },
      take,
    });

    return NextResponse.json({
      logs: logs.map((log) => ({
        ...log,
        createdAt: log.createdAt.toISOString(),
      })),
    });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Failed to load admin notification logs:", error);
    return NextResponse.json({ error: "Failed to load notification logs." }, { status: 500 });
  }
}
