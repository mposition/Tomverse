export const dynamic = "force-dynamic";
export const maxDuration = 180;

import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { countOpenWorkItems } from "@/lib/modelLifecycleWorkItems";
import { reportOperationalIncident } from "@/lib/operationalMonitoring";
import { checkProviderModelCatalogs } from "@/lib/providerModelCatalogMonitor";
import { reconcileCatalogWithRegistry } from "@/lib/providerModelCatalogReconciliation";
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
    // Acts on the checks before they are reported, so the daily report states
    // what the registry now looks like rather than what it looked like when
    // the scan started. A failure here must not lose the report -- detection
    // staying visible is worth more than the automation succeeding.
    const reconciliation = await reconcileCatalogWithRegistry({ results }).catch(
      (error) => {
        console.error("Provider model catalog reconciliation failed:", error);
        return undefined;
      }
    );
    // Read after the scan, so it counts the items this run just created as
    // well as everything still waiting from previous days -- which is the
    // number the report never had.
    const openWorkItems = await countOpenWorkItems().catch((error) => {
      console.error("Model lifecycle work item count failed:", error);
      return undefined;
    });
    const notification = await sendProviderModelCatalogReport({
      results,
      reconciliation,
      openWorkItems,
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
      registryDisabled: reconciliation?.disabled.length ?? 0,
      registryRestored: reconciliation?.restored.length ?? 0,
      registryHeld: reconciliation?.held.length ?? 0,
    };
    // A provider whose every enabled model went missing at once is far more
    // likely to be a broken catalog response than a real mass retirement.
    // The reconciler refuses to act on it, which means somebody has to look.
    if (reconciliation?.held.length) {
      await reportOperationalIncident({
        code: "PROVIDER_MODEL_CATALOG_RECONCILIATION_HELD",
        title: "Model catalog reconciliation held back a full-provider disable",
        severity: "warning",
        context: {
          component: "provider_model_catalog_monitor",
          providers: reconciliation.held.map((item) => item.provider).join(","),
        },
      }).catch(() => undefined);
    }
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
