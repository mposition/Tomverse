import { createHash, timingSafeEqual } from "node:crypto";
import { after } from "next/server";
import { cleanupExpiredData } from "@/lib/maintenance";
import { summarizeMaintenanceStepFailures } from "@/lib/maintenanceStepsCore";
import { runFeedbackAutoFixShadowWorker } from "@/lib/feedbackAutoFixShadow";
import { reportOperationalIncident } from "@/lib/operationalMonitoring";
import {
  completeScheduledJob,
  failScheduledJob,
  startScheduledJob,
} from "@/lib/scheduledJobs";

const isAuthorized = (request: Request) => {
  const configured = process.env.MAINTENANCE_SECRET;
  const authorization = request.headers.get("authorization");
  const provided = authorization?.startsWith("Bearer ")
    ? authorization.slice(7)
    : "";
  if (!configured || configured.length < 32 || !provided) return false;

  const expectedDigest = createHash("sha256").update(configured).digest();
  const providedDigest = createHash("sha256").update(provided).digest();
  return timingSafeEqual(expectedDigest, providedDigest);
};

export async function POST(request: Request) {
  if (!isAuthorized(request)) {
    return Response.json(
      { error: "Unauthorized" },
      {
        status: 401,
        headers: { "Cache-Control": "no-store" },
      }
    );
  }

  const run = await startScheduledJob("retention_cleanup");
  try {
    // Phase 2 shadow diagnosis rides the maintenance cadence. Diagnostics
    // only -- its failure must never fail the retention job, so it reports
    // through its own structured log and a warning here.
    const shadow = await runFeedbackAutoFixShadowWorker().catch((error) => {
      console.warn(
        JSON.stringify({
          event: "autofix_shadow_worker_failed",
          reason: error instanceof Error ? error.name : "unknown",
          at: new Date().toISOString(),
        })
      );
      return null;
    });
    if (shadow?.enabled) {
      console.info(
        JSON.stringify({
          event: "autofix_shadow_worker_run",
          ...shadow,
          at: new Date().toISOString(),
        })
      );
    }
    const deleted = await cleanupExpiredData();
    const processedCount = Object.values(deleted).reduce<number>(
      (sum, value) => sum + (typeof value === "number" ? value : 0),
      0
    );
    const result = JSON.parse(JSON.stringify(deleted));

    // A step that threw no longer ends the run, so a run can finish with work
    // both done and undone. That is still a failure -- the same alert has to
    // fire, and the dashboard's consecutive-failure count has to keep counting
    // -- but it is recorded with what did run and which steps did not, rather
    // than as one opaque error with no counts at all.
    if (deleted.failedSteps.length > 0) {
      const failure = new Error(
        summarizeMaintenanceStepFailures(deleted.failedSteps)
      );
      failure.name = "MaintenanceStepFailure";
      await failScheduledJob({
        runId: run?.id,
        error: failure,
        result,
        processedCount,
      });
      after(() =>
        reportOperationalIncident({
          code: "SCHEDULED_MAINTENANCE_CLEANUP_STEP_FAILED",
          title: "Scheduled maintenance cleanup step failed",
          error: failure,
          severity: "error",
          cooldownMs: 60 * 60 * 1_000,
          context: {
            component: "maintenance-cleanup",
            route: "/api/internal/maintenance/cleanup",
            failedSteps: deleted.failedSteps.map((step) => step.step).join(","),
          },
        })
      );
      return Response.json(
        { success: false, deleted },
        { status: 500, headers: { "Cache-Control": "no-store" } }
      );
    }

    await completeScheduledJob({
      runId: run?.id,
      processedCount,
      result,
    });
    return Response.json(
      { success: true, deleted },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    await failScheduledJob({ runId: run?.id, error });
    after(() =>
      reportOperationalIncident({
        code: "SCHEDULED_MAINTENANCE_CLEANUP_FAILED",
        title: "Scheduled maintenance cleanup failed",
        error,
        severity: "error",
        cooldownMs: 60 * 60 * 1_000,
        context: {
          component: "maintenance-cleanup",
          route: "/api/internal/maintenance/cleanup",
        },
      })
    );
    return Response.json(
      { error: "Maintenance cleanup failed." },
      {
        status: 500,
        headers: { "Cache-Control": "no-store" },
      }
    );
  }
}
