import "server-only";

import { planInfrastructureAlerts } from "@/lib/infrastructureAlertPolicy";
import { getInfrastructureDashboard } from "@/lib/infrastructureMonitoring";
import { reportOperationalIncident } from "@/lib/operationalMonitoring";
import { prisma } from "@/lib/prisma";
import {
  completeScheduledJob,
  failScheduledJob,
  startScheduledJob,
} from "@/lib/scheduledJobs";

const MONITOR_INTERVAL_MS = 15 * 60 * 1_000;

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
      plan.incidents.map(({ dependency, ...incident }) =>
        reportOperationalIncident({
          ...incident,
          cooldownMs: 30 * 60 * 1_000,
          context: { component: "infrastructure-threshold-monitor", dependency },
        })
      )
    );
    await completeScheduledJob({
      runId: run?.id,
      processedCount: plan.decisions.length,
      result: {
        alerts: plan.incidents.length,
        advisories: plan.advisories.length,
        suppressedAdvisories: plan.advisories,
        statuses: plan.statuses,
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
