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

import {
  marketingPublisherSilenceWhere,
  marketingPublisherSilentRuns,
} from "@/lib/marketingPublisherRunCore";

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

type PublisherQuery = {
  where?: {
    jobKey?: string;
    status?: string;
    OR?: Array<{
      heartbeatAt?: { lt?: Date } | null;
      startedAt?: { lt?: Date };
    }>;
  };
  orderBy?: unknown;
  take?: number;
};

/**
 * The subset of Prisma's semantics this monitor's query actually uses.
 *
 * Written out rather than stubbed because the bug it has to catch lives in the
 * query: a predicate that selects healthy rows, or a page taken before the rows
 * are ordered, both return the wrong fifty. A fake that ignored `where`,
 * `orderBy` and `take` would agree with either version.
 *
 * `nulls: "first"` matches PostgreSQL's own ordering for `ASC NULLS FIRST`, and
 * a null heartbeat means the run has never reported one -- older than any
 * timestamp, so it sorts before all of them.
 */
const applyQuery = (rows: PublisherRun[], args: PublisherQuery): PublisherRun[] => {
  const where = args.where ?? {};
  let selected = rows.filter((row) => {
    if (where.jobKey !== undefined && where.jobKey !== "marketing_publisher") return false;
    if (where.status !== undefined && where.status !== "running") return false;
    if (!where.OR) return true;
    return where.OR.some((clause) => {
      if (clause.heartbeatAt === null) {
        if (row.heartbeatAt !== null) return false;
        const limit = clause.startedAt?.lt;
        return limit === undefined || row.startedAt < limit;
      }
      const limit = clause.heartbeatAt?.lt;
      if (limit === undefined) return false;
      return row.heartbeatAt !== null && row.heartbeatAt < limit;
    });
  });
  if (args.orderBy) {
    selected = [...selected].sort((left, right) => {
      const leftAt = left.heartbeatAt;
      const rightAt = right.heartbeatAt;
      if (leftAt === null && rightAt !== null) return -1;
      if (leftAt !== null && rightAt === null) return 1;
      if (leftAt !== null && rightAt !== null && leftAt.getTime() !== rightAt.getTime()) {
        return leftAt.getTime() - rightAt.getTime();
      }
      return left.startedAt.getTime() - right.startedAt.getTime();
    });
  }
  return args.take === undefined ? selected : selected.slice(0, args.take);
};

type World = {
  dashboard: Record<string, unknown> | null;
  dashboardError: Error | null;
  runningPublisherRuns: PublisherRun[];
  publisherQueryError: Error | null;
  incidents: Incident[];
  completedResults: unknown[];
  failedRuns: number;
};

const world: World = {
  dashboard: null,
  dashboardError: null,
  runningPublisherRuns: [],
  publisherQueryError: null,
  incidents: [],
  completedResults: [],
  failedRuns: 0,
};

const resetWorld = () => {
  world.dashboard = null;
  world.dashboardError = null;
  world.runningPublisherRuns = [];
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
            findMany: async (args: PublisherQuery) => {
              if (world.publisherQueryError) throw world.publisherQueryError;
              return applyQuery(world.runningPublisherRuns, args);
            },
            count: async (args: PublisherQuery) => {
              if (world.publisherQueryError) throw world.publisherQueryError;
              return applyQuery(world.runningPublisherRuns, {
                ...args,
                take: undefined,
              }).length;
            },
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
  world.runningPublisherRuns = [
    // Started 20 minutes ago, never heartbeat: past the 15-minute threshold.
    { id: "run_silent", startedAt: new Date(now.getTime() - 20 * 60_000), heartbeatAt: null },
    // Heartbeat a minute ago: alive, and must not be named.
    { id: "run_alive", startedAt: new Date(now.getTime() - 20 * 60_000), heartbeatAt: new Date(now.getTime() - 60_000) },
  ];

  const result = await monitorInfrastructureThresholdsIfDue(now);

  const incident = world.incidents.find(
    (entry) => entry.code === "MARKETING_PUBLISHER_RUN_SILENT",
  );
  assert.equal(incident?.context?.component, "marketing-publisher");
  assert.equal(incident?.context?.silentRuns, "1");
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

test("a page of healthy long-running rows cannot crowd out a silent one", () => {
  // Codex's scenario, and the reason the predicate moved into the query. Fifty
  // rows that started long ago and beat a moment ago satisfied the old
  // `startedAt`-only filter, filled the unordered page of fifty, and left the
  // one genuinely silent run outside it -- so the alert reported nothing while a
  // dead worker's row sat open.
  //
  // This is a unit assertion on the two forms of the rule rather than a monitor
  // run, because what has to agree is the predicate and the page, and both are
  // arguments.
  const now = new Date("2026-09-24T12:00:00.000Z");
  const healthy: PublisherRun[] = Array.from({ length: 50 }, (_, index) => ({
    id: `healthy_${index}`,
    startedAt: new Date(now.getTime() - 6 * 60 * 60_000),
    heartbeatAt: new Date(now.getTime() - 1_000),
  }));
  const silentRun: PublisherRun = {
    id: "silent",
    startedAt: new Date(now.getTime() - 6 * 60 * 60_000),
    heartbeatAt: new Date(now.getTime() - 40 * 60_000),
  };
  const query = {
    where: marketingPublisherSilenceWhere(now),
    orderBy: [{ heartbeatAt: { sort: "asc", nulls: "first" } }, { startedAt: "asc" }],
    take: 50,
  } as PublisherQuery;

  const page = applyQuery([...healthy, silentRun], query);

  assert.deepEqual(
    page.map((row) => row.id),
    ["silent"],
    "only the silent row satisfies the predicate, so the page cannot omit it",
  );
  assert.equal(applyQuery([...healthy, silentRun], { ...query, take: undefined }).length, 1);
  // And the rule the monitor reports with agrees with the rule it selected by.
  assert.deepEqual(
    marketingPublisherSilentRuns(page, now).map((row) => row.id),
    ["silent"],
  );
});

test("the query form and the predicate form of the silence rule agree", () => {
  // Two forms of one rule is the hazard this pair is worth, so they are held
  // together on a case table rather than trusted to stay in step.
  const now = new Date("2026-09-24T12:00:00.000Z");
  const cases: PublisherRun[] = [
    // never beat, started long ago: silent
    { id: "a", startedAt: new Date(now.getTime() - 40 * 60_000), heartbeatAt: null },
    // never beat, started a moment ago: not silent, and must not be reported
    { id: "b", startedAt: new Date(now.getTime() - 60_000), heartbeatAt: null },
    // beat long ago: silent
    { id: "c", startedAt: new Date(now.getTime() - 40 * 60_000), heartbeatAt: new Date(now.getTime() - 20 * 60_000) },
    // beat a moment ago: not silent, whatever its start says
    { id: "d", startedAt: new Date(now.getTime() - 6 * 60 * 60_000), heartbeatAt: new Date(now.getTime() - 1_000) },
    // exactly at the threshold is not past it, on either form
    { id: "e", startedAt: new Date(now.getTime() - 15 * 60_000), heartbeatAt: null },
  ];
  const byQuery = applyQuery(cases, { where: marketingPublisherSilenceWhere(now) })
    .map((row) => row.id)
    .sort();
  const byPredicate = marketingPublisherSilentRuns(cases, now)
    .map((row) => row.id)
    .sort();
  assert.deepEqual(byQuery, ["a", "c"]);
  assert.deepEqual(byPredicate, byQuery);
});
