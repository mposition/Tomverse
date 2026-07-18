import "server-only";

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
  if (recent) return { checked: false, alerts: 0 };

  const run = await startScheduledJob("infrastructure_threshold_monitor");
  try {
    const dashboard = await getInfrastructureDashboard();
    const dependencies = [
      ["railway", dashboard.railway.status, dashboard.railway.message],
      ["r2", dashboard.r2.status, dashboard.r2.message],
      ["database", dashboard.database.status, dashboard.database.message],
      ["prisma", dashboard.prismaUsage.status, dashboard.prismaUsage.message],
    ] as const;
    const unhealthy = dependencies.filter(([, status]) => status === "warning" || status === "error");
    await Promise.all(
      unhealthy.map(([dependency, status, message]) =>
        reportOperationalIncident({
          code: `INFRASTRUCTURE_${dependency.toUpperCase()}_${status.toUpperCase()}`,
          title: `${dependency} infrastructure is ${status}`,
          error: message,
          severity: status === "error" ? "fatal" : "warning",
          cooldownMs: 30 * 60 * 1_000,
          context: { component: "infrastructure-threshold-monitor", dependency },
        })
      )
    );
    await completeScheduledJob({
      runId: run?.id,
      processedCount: dependencies.length,
      result: {
        alerts: unhealthy.length,
        statuses: Object.fromEntries(dependencies.map(([name, status]) => [name, status])),
      },
    });
    return { checked: true, alerts: unhealthy.length };
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
    return { checked: false, alerts: 0 };
  }
}
