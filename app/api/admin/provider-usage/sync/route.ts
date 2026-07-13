export const dynamic = "force-dynamic";
export const maxDuration = 120;

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { z } from "zod";
import { authOptions } from "@/lib/auth";
import { writeAdminAuditLog } from "@/lib/adminAudit";
import { hasAdminPermission, isAdminSession } from "@/lib/adminAuth";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
  readLimitedJson,
} from "@/lib/apiSecurity";
import {
  defaultProviderUsageSyncDate,
  syncProviderUsageForDate,
} from "@/lib/providerUsageSync";

const syncSchema = z
  .object({
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
  })
  .strict();

const parseDate = (value: string | undefined) => {
  if (!value) return defaultProviderUsageSyncDate();
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) ? defaultProviderUsageSyncDate() : parsed;
};

export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    if (!hasAdminPermission(session, "ops:write")) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }

    await consumeApiRateLimit(req, session.user.id, "admin-provider-usage-sync", {
      minute: 10,
      day: 100,
    });

    const body = await readLimitedJson(req, 2 * 1024, syncSchema);
    const date = parseDate(body.date);
    const results = await syncProviderUsageForDate(date);

    await writeAdminAuditLog({
      session,
      request: req,
      action: "provider.usage_sync",
      targetType: "ProviderUsage",
      targetId: date.toISOString().slice(0, 10),
      summary: `Synced provider usage for ${date.toISOString().slice(0, 10)}.`,
      metadata: {
        date: date.toISOString().slice(0, 10),
        synced: results.filter((result) => result.status === "synced").length,
        failed: results.filter((result) => result.status === "failed").length,
        skipped: results.filter((result) => result.status === "skipped").length,
        failures: results
          .filter((result) => result.status === "failed" && result.diagnostic)
          .map((result) => ({
            provider: result.provider,
            traceId: result.diagnostic?.traceId,
            httpStatus: result.diagnostic?.httpStatus,
            errorCode: result.diagnostic?.errorCode,
            providerRequestId: result.diagnostic?.providerRequestId,
            attemptCount: result.diagnostic?.attemptCount,
            elapsedMs: result.diagnostic?.elapsedMs,
            failureStage: result.diagnostic?.failureStage,
          })),
      },
    });

    return NextResponse.json({
      date: date.toISOString().slice(0, 10),
      results,
    });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Provider usage sync failed:", error);
    return NextResponse.json(
      { error: "Provider usage sync failed." },
      { status: 500 }
    );
  }
}
