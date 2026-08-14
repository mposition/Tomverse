import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

import {
  RETENTION_SWEEP_GRACE_DAYS,
  retentionPolicy,
} from "../../lib/retentionPolicyCore.ts";

/**
 * When the database probe is allowed to say cleanup is behind.
 *
 * The alarm it guards was on nearly all day and meant nothing. The probe
 * warned whenever *any* `ProviderErrorEvent` was past the 30-day policy
 * cutoff, and the sweep that removes them is a daily cron. So every morning
 * the 03:00 run emptied the table of anything older than 30 days, and by
 * lunchtime the rows that had crossed the line since then put the dashboard
 * back into `warning` -- for rows that were not late, that nothing had failed
 * to collect, and that would be gone at the next run.
 *
 * A warning that is always on is read as decoration. The cost is not the noise
 * itself but the day the sweep genuinely stops, when the dashboard says exactly
 * what it has been saying all along.
 *
 * So the probe now measures two different things and only one of them is a
 * fault: rows past the cutoff are the next sweep's work, and rows past the
 * cutoff *plus the grace* are work the sweep has already had two chances at.
 *
 * The counts here are driven off the `createdAt` bound the probe actually puts
 * in its query, rather than returned as fixed numbers, so the test fails if the
 * probe asks the wrong question -- which is the failure being fixed.
 */

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relativePath: string) =>
  pathToFileURL(resolve(ROOT, relativePath)).href;

const DAY_MS = 86_400_000;
const WINDOW_DAYS = retentionPolicy("providerErrors").windowDays as number;

/** Ages, in days, of the provider error rows the fake database holds. */
let rowAgesDays: number[] = [];

const providerErrorCount = async (args?: {
  where?: { createdAt?: { lt?: Date; gte?: Date } };
}) => {
  const now = Date.now();
  const before = args?.where?.createdAt?.lt;
  const since = args?.where?.createdAt?.gte;
  return rowAgesDays.filter((ageDays) => {
    const createdAt = now - ageDays * DAY_MS;
    if (before && createdAt >= before.getTime()) return false;
    if (since && createdAt < since.getTime()) return false;
    return true;
  }).length;
};

let dashboardPromise: Promise<
  typeof import("../../lib/infrastructureMonitoring")
> | null = null;

const loadDashboard = () => {
  if (!dashboardPromise) {
    const count = async () => 0;
    mock.module(mod("lib/prisma.ts"), {
      namedExports: {
        prisma: {
          infrastructureCreditConfig: {
            findUnique: async () => ({
              creditMicroUsd: BigInt(50_000_000),
              note: "opening credit",
            }),
          },
          session: { count },
          conversation: { count },
          message: { count },
          chatUsageBucket: { count },
          providerErrorEvent: { count: providerErrorCount },
        },
      },
    });
    dashboardPromise = import(
      mod("lib/infrastructureMonitoring.ts")
    ) as Promise<typeof import("../../lib/infrastructureMonitoring")>;
  }
  return dashboardPromise;
};

// The other probes are not under test. They read third-party billing APIs, so
// they are left unconfigured and their own statuses are ignored -- every
// assertion below is on `dashboard.database`.
globalThis.fetch = (async () => {
  throw new Error("not configured");
}) as typeof fetch;

const databaseSnapshot = async (ages: number[]) => {
  rowAgesDays = ages;
  const { getInfrastructureDashboard } = await loadDashboard();
  return (await getInfrastructureDashboard()).database;
};

test("an empty table is healthy", async () => {
  const database = await databaseSnapshot([]);
  assert.equal(database.status, "healthy");
  assert.equal(database.providerErrorsPendingCleanup, 0);
  assert.equal(database.providerErrorsOverdueCleanup, 0);
});

test("rows the next sweep will take are counted but do not warn", async () => {
  // The regression, stated as a case: a few hours past the cutoff, on a daily
  // sweep. Before this change every one of these lit the dashboard.
  const database = await databaseSnapshot([
    WINDOW_DAYS + 0.2,
    WINDOW_DAYS + 0.9,
  ]);

  assert.equal(
    database.providerErrorsPendingCleanup,
    2,
    "the rows are past the policy cutoff and the screen should still show them"
  );
  assert.equal(database.providerErrorsOverdueCleanup, 0);
  assert.equal(
    database.status,
    "healthy",
    "waiting for tonight's sweep is the design working"
  );
  assert.match(database.message, /healthy/);
});

test("a single missed sweep is still not an alarm", async () => {
  // Deliberate. One day puts the boundary exactly where the cron runs, and an
  // alarm that flips around 03:00 is measuring the clock rather than the sweep.
  const database = await databaseSnapshot([WINDOW_DAYS + 1.5]);

  assert.equal(database.providerErrorsPendingCleanup, 1);
  assert.equal(database.providerErrorsOverdueCleanup, 0);
  assert.equal(database.status, "healthy");
});

test("rows the sweep has had two chances at are a warning", async () => {
  const overdueAge = WINDOW_DAYS + RETENTION_SWEEP_GRACE_DAYS + 1;
  const database = await databaseSnapshot([overdueAge, WINDOW_DAYS + 0.5]);

  assert.equal(database.providerErrorsOverdueCleanup, 1);
  assert.equal(
    database.providerErrorsPendingCleanup,
    2,
    "an overdue row is also a pending one; the counts nest rather than partition"
  );
  assert.equal(database.status, "warning");
  // The operator gets told where to look. "Waiting for retention cleanup" said
  // what was true of the rows and nothing about what to do.
  assert.match(database.message, /overdue/);
  assert.match(database.message, /maintenance cron/);
});

test("a sweep that stopped weeks ago is still only a warning, and says so", async () => {
  const database = await databaseSnapshot([WINDOW_DAYS + 40, WINDOW_DAYS + 60]);

  assert.equal(database.providerErrorsOverdueCleanup, 2);
  assert.equal(
    database.status,
    "warning",
    "retention falling behind is not a database outage; `error` is reserved for the probe failing"
  );
});

test("rows inside the window are not cleanup work at all", async () => {
  // Includes the 24-hour count, which is a different question again: recent
  // failures are operational news, not a retention fault.
  const database = await databaseSnapshot([0.5, 3, WINDOW_DAYS - 1]);

  assert.equal(database.providerErrors24h, 1);
  assert.equal(database.providerErrorsPendingCleanup, 0);
  assert.equal(database.providerErrorsOverdueCleanup, 0);
  assert.equal(database.status, "healthy");
});
