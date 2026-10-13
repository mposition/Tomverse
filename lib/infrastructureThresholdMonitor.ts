import "server-only";

import {
  AMUX_BRIDGE_REMINDER_MS,
  amuxBridgeWatchHorizonStart,
  judgeAmuxBridgeLiveness,
  newlyLostAmuxWorkers,
  type AmuxBridgeLiveness,
} from "@/lib/amux/bridgeLivenessCore";
import { planInfrastructureAlerts } from "@/lib/infrastructureAlertPolicy";
import { getInfrastructureDashboard } from "@/lib/infrastructureMonitoring";
import { findSilentMarketingPublisherRuns } from "@/lib/marketingPublisherRun";
import { marketingPublisherSilentRuns } from "@/lib/marketingPublisherRunCore";
import {
  reportOperationalDependencyStatus,
  reportOperationalIncident,
} from "@/lib/operationalMonitoring";
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
  // The query is in lib/marketingPublisherRun.ts with the rest of the run's
  // database access, so an integration test can run it against a real
  // PostgreSQL and this file's fake can stand in for one function rather than
  // for a SQL engine. A fake that interpreted the statement would agree with
  // whatever the statement said, including the two orderings that were wrong.
  const { total, runs } = await findSilentMarketingPublisherRuns(prisma, now);
  if (total === 0) return 0;
  // The pure rule computes what the message says. It cannot disagree with the
  // query about *which* rows -- it is handed rows the query already chose; what
  // it adds is how long each has been silent.
  const silent = marketingPublisherSilentRuns(runs, now);
  if (silent.length === 0) return 0;
  await reportOperationalIncident({
    code: "MARKETING_PUBLISHER_RUN_SILENT",
    title: "Marketing publisher run went silent",
    severity: "error",
    cooldownMs: 30 * 60 * 1_000,
    context: {
      component: "marketing-publisher",
      silentRuns: String(total),
      oldestLastSignOfLife: silent
        .map((run) => run.lastSignOfLifeAt)
        .sort()[0] ?? "unknown",
    },
  });
  return total;
}

/**
 * The runtimes reported lost by the previous check in this process, so the
 * next one can tell a newly halted bridge from a reminder. In memory, like the
 * dependency state it sits beside (lib/operationalMonitoring.ts): after a
 * deploy the first check pages again, which is the existing behaviour.
 */
const bridgeAlertMemory = globalThis as typeof globalThis & {
  __tomverseAmuxBridgeLostWorkers?: ReadonlySet<string>;
};

/** At most this many names in one alert; the rest are counted. */
const MAX_NAMED_LOST_RUNTIMES = 10;

const describeLostRuntimes = (
  verdict: Extract<AmuxBridgeLiveness, { state: "lost" }>
) => {
  const named = verdict.lostRuntimes
    .slice(0, MAX_NAMED_LOST_RUNTIMES)
    .map(
      (runtime) =>
        `${runtime.workerName} (lease out since ${runtime.leaseExpiresAt.toISOString()})`
    );
  const unnamed = verdict.lostRuntimes.length - named.length;
  return unnamed > 0 ? [...named, `and ${unnamed} more`].join(", ") : named.join(", ");
};

/**
 * The AMUX execution bridges on the Ubuntu host, judged by the worker leases
 * they keep alive (lib/amux/bridgeLivenessCore.ts, docs/ops/amux/bridge-monitoring.md).
 *
 * A dependency status rather than a plain incident: the first run that finds a
 * runtime lost pages at once, a runtime that joins the lost set later pages at
 * once too, the same set pages again only every `AMUX_BRIDGE_REMINDER_MS`, and
 * the first run that finds every runtime live again says so. The message names
 * the lost workers, when their leases ran out and where to look -- never a
 * card or the reason a bridge stopped, which only the host knows.
 *
 * Only `lost` and `live` are reported. `lapsing` and `unwatched` are not
 * evidence the bridges are alive: reporting them healthy would announce a
 * recovery when a halted bridge's last lease merely ages out of the horizon.
 * Saying nothing keeps a lost runtime lost until its lease is live again, and
 * stops the reminders once it ages out.
 */
async function reportAmuxBridgeLiveness(
  now: Date
): Promise<{ state: AmuxBridgeLiveness["state"]; notified: boolean }> {
  const leases = await prisma.amuxWorkerRuntime.findMany({
    where: { leaseExpiresAt: { gt: amuxBridgeWatchHorizonStart(now) } },
    select: { workerName: true, leaseExpiresAt: true },
  });
  // The judgement drops runtimes no bridge runs (AMUX_NON_BRIDGE_WORKERS).
  const verdict = judgeAmuxBridgeLiveness(leases, now);
  if (verdict.state !== "lost" && verdict.state !== "live") {
    return { state: verdict.state, notified: false };
  }
  const previouslyLost = bridgeAlertMemory.__tomverseAmuxBridgeLostWorkers ?? new Set();
  const newlyLost = newlyLostAmuxWorkers(previouslyLost, verdict);
  const report = await reportOperationalDependencyStatus({
    dependency: "amux-execution-bridge",
    healthy: verdict.state === "live",
    code: "AMUX_EXECUTION_BRIDGE_LOST",
    title: "AMUX execution bridge stopped heartbeating",
    error:
      verdict.state === "lost"
        ? `${verdict.lostRuntimes.length} of ${verdict.watchedRuntimes} AMUX worker runtimes ` +
          `stopped renewing their lease: ${describeLostRuntimes(verdict)}. ` +
          "Read the halt line of each one's bridge unit on the Ubuntu host before restarting it."
        : "Every AMUX worker runtime holds a live lease.",
    severity: "error",
    cooldownMs: AMUX_BRIDGE_REMINDER_MS,
    forceNotification: newlyLost.length > 0,
    context: {
      component: "amux-execution-bridge",
      adminPath: "/admin/office",
      ...(verdict.state === "lost"
        ? {
            lostWorkers: verdict.lostRuntimes
              .map((runtime) => runtime.workerName)
              .join(", "),
            ...(newlyLost.length > 0 ? { newlyLost: newlyLost.join(", ") } : {}),
            liveRuntimes: String(verdict.liveRuntimes),
            lostSince: verdict.lostSince.toISOString(),
            minutesLost: String(
              Math.floor((now.getTime() - verdict.lostSince.getTime()) / 60_000)
            ),
          }
        : {}),
    },
  });
  bridgeAlertMemory.__tomverseAmuxBridgeLostWorkers = new Set(
    verdict.state === "lost"
      ? verdict.lostRuntimes.map((runtime) => runtime.workerName)
      : []
  );
  return { state: verdict.state, notified: report.notified };
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
    // **"Could not check" is itself an operational condition, and it has to
    // page.** Recording null and moving on left the monitor finishing
    // `succeeded` with `alerts: 0`, so a query that fails every run disabled the
    // stale-run watch permanently and nothing said so -- a test even pinned that
    // as "pages nothing". This watch is the only thing that notices a dead
    // worker's row, so a watch that has stopped working reports on its own behalf.
    const silentPublisherRuns = await reportSilentMarketingPublisherRuns(now).catch(
      async (error: unknown) => {
        console.error("Marketing publisher silence check failed:", error);
        await reportOperationalIncident({
          code: "MARKETING_PUBLISHER_SILENCE_CHECK_FAILED",
          title: "The marketing publisher silence check could not run",
          error,
          severity: "error",
          cooldownMs: 30 * 60 * 1_000,
          context: { component: "marketing-publisher" },
        }).catch((reportError: unknown) => {
          console.error("Silence-check incident could not be reported:", reportError);
        });
        return null;
      },
    );
    // `alerts` counts what was actually reported, which now includes the
    // publisher's own incident. Reporting one and returning zero made the
    // number disagree with the thing it counts -- and the row and the API
    // response are where an operator looks to see whether the monitor did
    // anything.
    // A failed check now reports an alert of its own, so null counts as one too:
    // the number has to agree with what was actually sent.
    const publisherAlerts = silentPublisherRuns === 0 ? 0 : 1;
    // The same rule as the publisher watch: a bridge check that cannot read
    // pages on its own behalf and is recorded as null, so a failing read cannot
    // turn the watch off while the monitor reports success.
    const amuxBridge = await reportAmuxBridgeLiveness(now).catch(
      async (error: unknown) => {
        console.error("AMUX execution bridge check failed:", error);
        await reportOperationalIncident({
          code: "AMUX_EXECUTION_BRIDGE_CHECK_FAILED",
          title: "The AMUX execution bridge check could not run",
          error,
          severity: "error",
          cooldownMs: 30 * 60 * 1_000,
          context: { component: "amux-execution-bridge" },
        }).catch((reportError: unknown) => {
          console.error("Bridge-check incident could not be reported:", reportError);
        });
        return null;
      },
    );
    // A reminder held back by its cooldown was not sent, so it is not counted.
    const bridgeAlerts = amuxBridge === null || amuxBridge.notified ? 1 : 0;
    const alerts = plan.incidents.length + publisherAlerts + bridgeAlerts;
    await completeScheduledJob({
      runId: run?.id,
      processedCount: plan.decisions.length,
      result: {
        alerts,
        advisories: plan.advisories.length,
        suppressedAdvisories: plan.advisories,
        statuses: plan.statuses,
        silentPublisherRuns,
        amuxBridge: amuxBridge?.state ?? null,
      },
    });
    return {
      checked: true,
      alerts,
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
