import "server-only";

import { planInfrastructureAlerts } from "@/lib/infrastructureAlertPolicy";
import { getInfrastructureDashboard } from "@/lib/infrastructureMonitoring";
import {
  MARKETING_PUBLISHER_JOB_KEY,
  MARKETING_PUBLISHER_SILENCE_THRESHOLD_MS,
  marketingPublisherSilentRuns,
} from "@/lib/marketingPublisherRunCore";
import { reportOperationalIncident } from "@/lib/operationalMonitoring";
import { prisma } from "@/lib/prisma";
import {
  completeScheduledJob,
  failScheduledJob,
  startScheduledJob,
} from "@/lib/scheduledJobs";

const MONITOR_INTERVAL_MS = 15 * 60 * 1_000;

/**
 * Marketing publisher runs that started and then went quiet (S2 plan, S2d1).
 *
 * A different question from the scheduled-jobs dashboard's "has this job run
 * recently". A run is killed at its four-minute deadline; a row still
 * `running` with no heartbeat after the threshold is not a slow run, it is one
 * whose worker is gone and which nothing closed. The threshold and the owner
 * of the alert are this application's, not Railway's -- Railway knows the
 * process ended, not that the run it was part of was left open.
 *
 * Reported through the existing operational incident path, so it lands in the
 * same queue and notifications as everything else this monitor raises.
 */
async function reportSilentMarketingPublisherRuns(now: Date): Promise<number> {
  const running = await prisma.scheduledJobRun.findMany({
    where: {
      jobKey: MARKETING_PUBLISHER_JOB_KEY,
      status: "running",
      startedAt: { lt: new Date(now.getTime() - MARKETING_PUBLISHER_SILENCE_THRESHOLD_MS) },
    },
    select: { id: true, startedAt: true, heartbeatAt: true },
    // Bounded: this is an alert, and one incident naming the count says as
    // much as fifty naming each row.
    take: 50,
  });
  const silent = marketingPublisherSilentRuns(running, now);
  if (silent.length === 0) return 0;
  await reportOperationalIncident({
    code: "MARKETING_PUBLISHER_RUN_SILENT",
    title: "Marketing publisher run went silent",
    severity: "error",
    cooldownMs: 30 * 60 * 1_000,
    context: {
      component: "marketing-publisher",
      silentRuns: String(silent.length),
      oldestLastSignOfLife: silent
        .map((run) => run.lastSignOfLifeAt)
        .sort()[0] ?? "unknown",
    },
  });
  return silent.length;
}

export async function monitorInfrastructureThresholdsIfDue(now = new Date()) {
  const recent = await prisma.scheduledJobRun.findFirst({
    where: {
      jobKey: "infrastructure_threshold_monitor",
      startedAt: { gte: new Date(now.getTime() - MONITOR_INTERVAL_MS) },
    },
    select: { id: true },
  }).catch(() => null);
  if (recent) return { checked: false, alerts: 0, advisories: 0 };

  const run = await startScheduledJob("infrastructure_threshold_monitor");
  try {
    const dashboard = await getInfrastructureDashboard();
    // Dashboard-only advisories (e.g. Railway PROJECTED_BALANCE_LOW) stay on
    // the Admin screen and scheduled reports; only actionable incidents reach
    // the real-time channels. `alerts` counts what was actually reported.
    const plan = planInfrastructureAlerts(dashboard);
    await Promise.all(
      plan.incidents.map(({ dependency, reasonCodes, ...incident }) =>
        reportOperationalIncident({
          ...incident,
          cooldownMs: 30 * 60 * 1_000,
          context: {
            component: "infrastructure-threshold-monitor",
            dependency,
            // Joined rather than passed as an array: the context sanitizer
            // JSON-stringifies anything that is not a scalar, which would put
            // `["R2_API_ERROR"]` in a Sentry tag nobody can read at a glance.
            ...(reasonCodes.length > 0
              ? { reasons: reasonCodes.join(", ") }
              : {}),
          },
        })
      )
    );
    // Its own failure is its own: a query that could not be read here must not
    // fail the infrastructure check that has already run, and "could not
    // check" is recorded as `null` rather than as zero silent runs.
    const silentPublisherRuns = await reportSilentMarketingPublisherRuns(now).catch(
      (error: unknown) => {
        console.error("Marketing publisher silence check failed:", error);
        return null;
      },
    );
    await completeScheduledJob({
      runId: run?.id,
      processedCount: plan.decisions.length,
      result: {
        alerts: plan.incidents.length,
        advisories: plan.advisories.length,
        suppressedAdvisories: plan.advisories,
        statuses: plan.statuses,
        silentPublisherRuns,
      },
    });
    return {
      checked: true,
      alerts: plan.incidents.length,
      advisories: plan.advisories.length,
    };
  } catch (error) {
    await failScheduledJob({ runId: run?.id, error });
    await reportOperationalIncident({
      code: "INFRASTRUCTURE_THRESHOLD_MONITOR_FAILED",
      title: "Infrastructure threshold monitor failed",
      error,
      severity: "error",
      cooldownMs: 30 * 60 * 1_000,
      context: { component: "infrastructure-threshold-monitor" },
    });
    return { checked: false, alerts: 0, advisories: 0 };
  }
}
