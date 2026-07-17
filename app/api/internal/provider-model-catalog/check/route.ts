export const dynamic = "force-dynamic";
export const maxDuration = 180;

import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { reportOperationalIncident } from "@/lib/operationalMonitoring";
import { checkProviderModelCatalogs } from "@/lib/providerModelCatalogMonitor";
import { sendProviderModelCatalogReport } from "@/lib/providerModelCatalogReport";
import {
  completeScheduledJob,
  failScheduledJob,
  startScheduledJob,
} from "@/lib/scheduledJobs";

const authorized = (request: Request) => {
  const secret =
    process.env.PROVIDER_MODEL_CATALOG_SYNC_SECRET ||
    process.env.MAINTENANCE_SECRET;
  if (!secret || secret.length < 32) return false;
  const authorization = request.headers.get("authorization");
  const provided = authorization?.startsWith("Bearer ")
    ? authorization.slice(7)
    : "";
  if (!provided) return false;
  return timingSafeEqual(
    createHash("sha256").update(secret).digest(),
    createHash("sha256").update(provided).digest()
  );
};

export async function POST(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  const scheduledRun = await startScheduledJob("provider_model_catalog_monitor");
  try {
    const generatedAt = new Date();
    const results = await checkProviderModelCatalogs(generatedAt);
    const notification = await sendProviderModelCatalogReport({
      results,
      generatedAt,
      test: new URL(request.url).searchParams.get("test") === "true",
    });
    const checked = results.filter((result) => result.status === "checked").length;
    const failed = results.filter((result) => result.status === "failed").length;
    const skipped = results.filter((result) => result.status === "skipped").length;
    const missing = results.reduce((sum, result) => sum + result.missing.length, 0);
    const newCandidates = results.reduce(
      (sum, result) => sum + result.newCandidates.length,
      0
    );
    const lifecycleWarnings = results.reduce(
      (sum, result) => sum + result.lifecycleWarnings.length,
      0
    );
    const summary = {
      generatedAt: generatedAt.toISOString(),
      checked,
      failed,
      skipped,
      missing,
      newCandidates,
      lifecycleWarnings,
      slackDelivered: notification.slack.delivered,
      emailDelivered: notification.email.filter((item) => item.delivered).length,
    };
    if (checked === 0) {
      throw new Error("No provider model catalog check completed successfully.");
    }
    await completeScheduledJob({
      runId: scheduledRun?.id,
      processedCount: checked,
      result: summary,
    });
    return NextResponse.json({ ...summary, results, notification });
  } catch (error) {
    await failScheduledJob({ runId: scheduledRun?.id, error });
    await reportOperationalIncident({
      code: "PROVIDER_MODEL_CATALOG_MONITOR_FAILED",
      title: "Provider model catalog monitor failed",
      error,
      severity: "error",
      context: { component: "provider_model_catalog_monitor" },
    }).catch(() => undefined);
    console.error("Provider model catalog monitor failed:", error);
    return NextResponse.json(
      { error: "Provider model catalog monitor failed." },
      { status: 500 }
    );
  }
}
