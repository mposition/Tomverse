export const dynamic = "force-dynamic";
export const maxDuration = 180;

import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import {
  defaultProviderUsageSyncDate,
  syncProviderUsageForDate,
} from "@/lib/providerUsageSync";
import { getProviderHealthDashboard } from "@/lib/providerMonitoring";
import { sendDailyProviderUsageSlackReport } from "@/lib/providerDailyUsageReport";
import { sendDailyInfrastructureSlackReport } from "@/lib/infrastructureSlackReport";
import {
  completeScheduledJob,
  failScheduledJob,
  startScheduledJob,
} from "@/lib/scheduledJobs";

const secretsMatch = (expected: string, provided: string) => {
  const expectedDigest = createHash("sha256").update(expected).digest();
  const providedDigest = createHash("sha256").update(provided).digest();
  return timingSafeEqual(expectedDigest, providedDigest);
};

const authorized = (req: Request) => {
  const secret = process.env.PROVIDER_USAGE_SYNC_SECRET;
  if (!secret || secret.length < 32) return false;

  const auth = req.headers.get("authorization");
  const provided = auth?.startsWith("Bearer ") ? auth.slice(7) : "";
  if (provided && secretsMatch(secret, provided)) return true;

  const headerSecret = req.headers.get("x-internal-secret");
  if (headerSecret && secretsMatch(secret, headerSecret)) return true;

  return false;
};

const dateFromUrl = (req: Request) => {
  const url = new URL(req.url);
  const date = url.searchParams.get("date");
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return defaultProviderUsageSyncDate();
  }
  const parsed = new Date(`${date}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) ? defaultProviderUsageSyncDate() : parsed;
};

export async function POST(req: Request) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  const date = dateFromUrl(req);
  const run = await startScheduledJob("provider_usage_sync");
  const notifySlack = new URL(req.url).searchParams.get("notify") === "slack";
  const infrastructureNotification = notifySlack
    ? await sendDailyInfrastructureSlackReport().catch((error) => {
        console.error("Daily infrastructure Slack report failed:", error);
        return {
          delivered: false,
          status: "failed" as const,
          error:
            error instanceof Error
              ? error.message
              : "Infrastructure report failed.",
        };
      })
    : null;

  try {
    const results = await syncProviderUsageForDate(date);
    const notification = notifySlack
      ? await sendDailyProviderUsageSlackReport({
          date: date.toISOString().slice(0, 10),
          results,
          dashboard: await getProviderHealthDashboard(),
        })
      : null;
    await completeScheduledJob({
      runId: run?.id,
      processedCount: results.length,
      result: {
        date: date.toISOString().slice(0, 10),
        synced: results.filter((result) => result.status === "synced").length,
        skipped: results.filter((result) => result.status === "skipped").length,
        failed: results.filter((result) => result.status === "failed").length,
        slackDelivered: notification?.delivered ?? null,
        infrastructureSlackDelivered:
          infrastructureNotification?.delivered ?? null,
      },
    });
    return NextResponse.json({
      date: date.toISOString().slice(0, 10),
      results,
      notification,
      infrastructureNotification,
    });
  } catch (error) {
    await failScheduledJob({ runId: run?.id, error });
    console.error("Internal provider usage sync failed:", error);
    return NextResponse.json(
      {
        error: "Provider usage sync failed.",
        date: date.toISOString().slice(0, 10),
        infrastructureNotification,
      },
      { status: 500 }
    );
  }
}
