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

type PublisherRun = {
  id: string;
  startedAt: Date;
  heartbeatAt: Date | null;
};

type World = {
  dashboard: Record<string, unknown> | null;
  dashboardError: Error | null;
  runningPublisherRuns: PublisherRun[];
  /** What the query said the total was, when it differs from the rows given. */
  silentTotal: number | null;
  publisherQueryError: Error | null;
  incidents: Incident[];
  completedResults: unknown[];
  failedRuns: number;
};

const world: World = {
  dashboard: null,
  dashboardError: null,
  runningPublisherRuns: [],
  silentTotal: null,
  publisherQueryError: null,
  incidents: [],
  completedResults: [],
  failedRuns: 0,
};

const resetWorld = () => {
  world.dashboard = null;
  world.dashboardError = null;
  world.runningPublisherRuns = [];
  world.silentTotal = null;
  world.publisherQueryError = null;
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
            // The marketing publisher silence check reads the running rows.
            // A mock without this method is the shape that let the monitor
            // throw `findMany is not a function` on every single call while
            // the unit suite stayed green -- the gate that catches it is this
            // file, and only because this file loads the real monitor.
          },
        },
      },
    });
    mock.module(mod("lib/marketingPublisherRun.ts"), {
      namedExports: {
        // A canned answer, not a simulation of the statement. Whether the SQL
        // selects the right rows in the right order is asked of a real
        // PostgreSQL in tests/integration/marketing-automation-schema.db.test.ts;
        // a fake that interpreted the statement would agree with whatever it
        // said, including the two orderings that were wrong.
        findSilentMarketingPublisherRuns: async () => {
          if (world.publisherQueryError) throw world.publisherQueryError;
          return {
            total: world.silentTotal ?? world.runningPublisherRuns.length,
            runs: world.runningPublisherRuns,
          };
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
      silentPublisherRuns: 0,
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

test("a silent marketing publisher run pages, and is counted as an alert", async () => {
  resetWorld();
  const { monitorInfrastructureThresholdsIfDue } = await loadMonitor();
  const now = new Date("2026-09-24T00:30:00.000Z");
  world.dashboard = dashboard();
  // The query decides which rows are silent, so what it hands back is silent by
  // construction. Whether it picks the right ones -- and puts the longest-silent
  // first -- is asked of a real PostgreSQL in the integration suite; a fake that
  // filtered here would only be agreeing with itself.
  world.runningPublisherRuns = [
    { id: "run_silent", startedAt: new Date(now.getTime() - 20 * 60_000), heartbeatAt: null },
  ];

  const result = await monitorInfrastructureThresholdsIfDue(now);

  const incident = world.incidents.find(
    (entry) => entry.code === "MARKETING_PUBLISHER_RUN_SILENT",
  );
  assert.equal(incident?.context?.component, "marketing-publisher");
  assert.equal(incident?.context?.silentRuns, "1");
  // The message names how long the worst one has been quiet, computed by the
  // pure rule from the row the query chose.
  assert.equal(
    incident?.context?.oldestLastSignOfLife,
    new Date(now.getTime() - 20 * 60_000).toISOString(),
  );
  // The count and the alert number are the same fact. Reporting an incident
  // and returning `alerts: 0` told an operator reading either the row or the
  // API that the monitor had done nothing.
  assert.deepEqual(result, { checked: true, alerts: 1, advisories: 0 });
  assert.equal(
    (world.completedResults.at(-1) as { silentPublisherRuns: number }).silentPublisherRuns,
    1,
  );
});

test("a silence check that cannot read records null, not zero, and pages nothing", async () => {
  resetWorld();
  const { monitorInfrastructureThresholdsIfDue } = await loadMonitor();
  world.dashboard = dashboard();
  // "Could not check" and "checked, nothing silent" are different facts, and
  // an operator acts differently on each.
  world.publisherQueryError = new Error("query failed");

  const result = await monitorInfrastructureThresholdsIfDue();

  assert.deepEqual(result, { checked: true, alerts: 0, advisories: 0 });
  assert.equal(
    (world.completedResults.at(-1) as { silentPublisherRuns: number | null })
      .silentPublisherRuns,
    null,
  );
  assert.equal(
    world.incidents.some((entry) => entry.code === "MARKETING_PUBLISHER_RUN_SILENT"),
    false,
  );
  // The infrastructure check itself still ran and still succeeded.
  assert.equal(world.failedRuns, 0);
});

test("the incident reports the count the query returned, not the rows it named", async () => {
  resetWorld();
  const { monitorInfrastructureThresholdsIfDue } = await loadMonitor();
  const now = new Date("2026-09-24T00:30:00.000Z");
  world.dashboard = dashboard();
  // The query caps its page at fifty and its count is not capped by that, so
  // the two are different facts and the message has to use the right one. They
  // come from one statement, which is what stops them disagreeing about the
  // snapshot -- the defect that made them two queries a defect.
  world.silentTotal = 137;
  world.runningPublisherRuns = Array.from({ length: 50 }, (_, index) => ({
    id: "run_" + index,
    startedAt: new Date(now.getTime() - 60 * 60_000),
    heartbeatAt: null,
  }));

  const result = await monitorInfrastructureThresholdsIfDue(now);

  const incident = world.incidents.find(
    (entry) => entry.code === "MARKETING_PUBLISHER_RUN_SILENT",
  );
  assert.equal(incident?.context?.silentRuns, "137");
  assert.deepEqual(result, { checked: true, alerts: 1, advisories: 0 });
  assert.equal(
    (world.completedResults.at(-1) as { silentPublisherRuns: number }).silentPublisherRuns,
    137,
  );
});
