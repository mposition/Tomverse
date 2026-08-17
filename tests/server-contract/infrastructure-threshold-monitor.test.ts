import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

/**
 * Monitor-level contract for the infrastructure threshold monitor.
 *
 * The regression this guards: a persistent Railway PROJECTED_BALANCE_LOW
 * estimate used to re-create an operational incident on every 30-minute
 * cooldown window, paging Sentry, Resend and Slack/Discord for a condition
 * that needs no operator action. The monitor must keep the advisory visible
 * in its scheduled-job result while reporting only actionable incidents.
 *
 * Only the dashboard source, Prisma, the scheduled-job bookkeeping and the
 * incident reporter are replaced. The monitor and the alert policy are real.
 */

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relativePath: string) =>
  pathToFileURL(resolve(ROOT, relativePath)).href;

type Incident = {
  code: string;
  title: string;
  error: unknown;
  severity?: string;
  context?: Record<string, unknown>;
};

type World = {
  dashboard: Record<string, unknown> | null;
  dashboardError: Error | null;
  incidents: Incident[];
  completedResults: unknown[];
  failedRuns: number;
};

const world: World = {
  dashboard: null,
  dashboardError: null,
  incidents: [],
  completedResults: [],
  failedRuns: 0,
};

const resetWorld = () => {
  world.dashboard = null;
  world.dashboardError = null;
  world.incidents = [];
  world.completedResults = [];
  world.failedRuns = 0;
};

const snapshot = (status: string, message: string, warningReasons: Array<{ code: string; detail: string }> = []) => ({
  status,
  message,
  warningReasons,
});

const dashboard = (overrides: Record<string, unknown> = {}) => ({
  generatedAt: new Date().toISOString(),
  railway: snapshot("healthy", "ok"),
  r2: snapshot("healthy", "ok"),
  database: snapshot("healthy", "ok"),
  prismaUsage: snapshot("healthy", "ok"),
  ...overrides,
});

let monitorPromise: Promise<
  typeof import("../../lib/infrastructureThresholdMonitor")
> | null = null;

const loadMonitor = () => {
  if (!monitorPromise) {
    mock.module(mod("lib/prisma.ts"), {
      namedExports: {
        prisma: {
          scheduledJobRun: {
            findFirst: async () => null,
          },
        },
      },
    });
    mock.module(mod("lib/infrastructureMonitoring.ts"), {
      namedExports: {
        getInfrastructureDashboard: async () => {
          if (world.dashboardError) throw world.dashboardError;
          return world.dashboard;
        },
      },
    });
    mock.module(mod("lib/operationalMonitoring.ts"), {
      namedExports: {
        reportOperationalIncident: async (incident: Incident) => {
          world.incidents.push(incident);
          return { notified: true, suppressed: false };
        },
      },
    });
    mock.module(mod("lib/scheduledJobs.ts"), {
      namedExports: {
        startScheduledJob: async () => ({ id: "run_1" }),
        completeScheduledJob: async ({ result }: { result: unknown }) => {
          world.completedResults.push(result);
        },
        failScheduledJob: async () => {
          world.failedRuns += 1;
        },
      },
    });
    monitorPromise = import(
      mod("lib/infrastructureThresholdMonitor.ts")
    ) as Promise<typeof import("../../lib/infrastructureThresholdMonitor")>;
  }
  return monitorPromise;
};

test("PROJECTED_BALANCE_LOW alone reports no incident but stays observable", async () => {
  resetWorld();
  const { monitorInfrastructureThresholdsIfDue } = await loadMonitor();
  world.dashboard = dashboard({
    railway: snapshot(
      "warning",
      "Railway usage was synchronized, but projected remaining credit is below 20%.",
      [{ code: "PROJECTED_BALANCE_LOW", detail: "Projected remaining credit is low." }]
    ),
  });

  const result = await monitorInfrastructureThresholdsIfDue();

  assert.deepEqual(world.incidents, []);
  assert.deepEqual(result, { checked: true, alerts: 0, advisories: 1 });
  assert.deepEqual(world.completedResults, [
    {
      alerts: 0,
      advisories: 1,
      suppressedAdvisories: [
        { dependency: "railway", reasonCodes: ["PROJECTED_BALANCE_LOW"] },
      ],
      statuses: {
        railway: "warning",
        r2: "healthy",
        database: "healthy",
        prisma: "healthy",
      },
    },
  ]);
});

test("railway errors and other dependency warnings still page", async () => {
  resetWorld();
  const { monitorInfrastructureThresholdsIfDue } = await loadMonitor();
  world.dashboard = dashboard({
    railway: snapshot("error", "Railway API returned 500.", [
      { code: "RAILWAY_API_ERROR", detail: "Railway API returned 500." },
    ]),
    r2: snapshot("warning", "R2 metric above 80%."),
  });

  const result = await monitorInfrastructureThresholdsIfDue();

  assert.deepEqual(result, { checked: true, alerts: 2, advisories: 0 });
  assert.deepEqual(
    world.incidents
      .map((incident) => [incident.code, incident.severity])
      .sort(),
    [
      ["INFRASTRUCTURE_R2_WARNING", "warning"],
      ["INFRASTRUCTURE_RAILWAY_ERROR", "fatal"],
    ]
  );
  for (const incident of world.incidents) {
    assert.equal(
      incident.context?.component,
      "infrastructure-threshold-monitor"
    );
  }
});

test("the reason code the probe worked out reaches the alert", async () => {
  resetWorld();
  const { monitorInfrastructureThresholdsIfDue } = await loadMonitor();
  // The production incident: the alert carried Cloudflare's bare sentence and
  // nothing naming which credential produced it, while the probe had already
  // decided this was R2_API_ERROR -- a permission failure a person must fix --
  // rather than R2_USAGE_API_UNAVAILABLE. The reason was computed and then
  // dropped between the probe and the channels.
  world.dashboard = dashboard({
    r2: snapshot("error", "not authorized for that account", [
      { code: "R2_API_ERROR", detail: "not authorized for that account" },
    ]),
  });

  await monitorInfrastructureThresholdsIfDue();

  const incident = world.incidents[0];
  assert.equal(incident?.code, "INFRASTRUCTURE_R2_ERROR");
  assert.equal(incident?.context?.reasons, "R2_API_ERROR");
  assert.equal(incident?.context?.dependency, "r2");
  // The title names the read that failed. The probe never touches a bucket,
  // and uploads authenticate with unrelated S3 credentials, so "r2
  // infrastructure is error" told the on-call that user storage was down.
  assert.equal(incident?.title, "Cloudflare R2 usage analytics read failed");
  // `reasonCodes` is consumed here, not forwarded as its own incident field.
  assert.equal("reasonCodes" in (incident as object), false);
});

test("a dependency with no reason codes reports no reasons key at all", async () => {
  resetWorld();
  const { monitorInfrastructureThresholdsIfDue } = await loadMonitor();
  world.dashboard = dashboard({
    database: snapshot("error", "Database unreachable."),
  });

  await monitorInfrastructureThresholdsIfDue();

  // An empty string would read as "the reasons were checked and there were
  // none", which is a different claim from "this probe supplies none".
  assert.equal("reasons" in (world.incidents[0]?.context ?? {}), false);
});

test("an unknown new railway warning reason still pages", async () => {
  resetWorld();
  const { monitorInfrastructureThresholdsIfDue } = await loadMonitor();
  world.dashboard = dashboard({
    railway: snapshot("warning", "Something new happened.", [
      { code: "SOME_NEW_WARNING", detail: "Unvetted warning." },
    ]),
  });

  const result = await monitorInfrastructureThresholdsIfDue();

  assert.deepEqual(result, { checked: true, alerts: 1, advisories: 0 });
  assert.equal(world.incidents[0]?.code, "INFRASTRUCTURE_RAILWAY_WARNING");
});

test("a monitor failure still reports INFRASTRUCTURE_THRESHOLD_MONITOR_FAILED", async () => {
  resetWorld();
  const { monitorInfrastructureThresholdsIfDue } = await loadMonitor();
  world.dashboardError = new Error("dashboard exploded");

  const result = await monitorInfrastructureThresholdsIfDue();

  assert.deepEqual(result, { checked: false, alerts: 0, advisories: 0 });
  assert.equal(world.failedRuns, 1);
  assert.equal(
    world.incidents[0]?.code,
    "INFRASTRUCTURE_THRESHOLD_MONITOR_FAILED"
  );
});
