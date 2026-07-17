export const dynamic = "force-dynamic";
export const maxDuration = 180;

import { NextResponse } from "next/server";
import {
  defaultProviderUsageSyncDate,
  syncProviderUsageForDate,
} from "@/lib/providerUsageSync";
import { getProviderHealthDashboard } from "@/lib/providerMonitoring";
import { sendDailyProviderUsageSlackReport } from "@/lib/providerDailyUsageReport";
import { sendDailyInfrastructureSlackReport } from "@/lib/infrastructureSlackReport";

const authorized = (req: Request) => {
  const secret = process.env.PROVIDER_USAGE_SYNC_SECRET;
  if (!secret) return false;
  const auth = req.headers.get("authorization");
  const headerSecret = req.headers.get("x-internal-secret");
  return auth === `Bearer ${secret}` || headerSecret === secret;
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
    return NextResponse.json({
      date: date.toISOString().slice(0, 10),
      results,
      notification,
      infrastructureNotification,
    });
  } catch (error) {
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
