import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

/**
 * Route-level contract for how the fifteen-minute reconciliation reacts to a
 * database that dropped its connection.
 *
 * The incident this guards: a managed Postgres restart severed the connection
 * under `prisma.chatCreditReservation.findMany()`, which Prisma reported as
 * `08P01` / "server conn crashed?". The route had no retry and one catch that
 * called every failure fatal, so a blip that the very next run sailed through
 * produced a fatal CREDIT_RESERVATION_RECONCILIATION_FAILED incident *and* a
 * 500, which made the Railway job container exit non-zero and post a
 * "Deploy Crashed" notification. Three alerts, nothing broken.
 *
 * The sweep is idempotent, so the rules are:
 *
 *   * a dropped connection is retried once, and a successful retry is an
 *     ordinary run -- no incident, no 500;
 *   * a drop that survives the retry is reported as a deferral (`error`, not
 *     `fatal`) and answered 503, so the caller defers instead of crashing; and
 *   * anything else is untouched: no retry, still fatal, still 500.
 *
 * Only the route's collaborators are replaced. The route is real.
 */

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relativePath: string) =>
  pathToFileURL(resolve(ROOT, relativePath)).href;

const MAINTENANCE_SECRET = "maintenance-secret-value-32-characters-long";

type Incident = {
  code: string;
  severity?: string;
  context?: Record<string, unknown>;
};

type World = {
  reconcileErrors: unknown[];
  reconcileCalls: number;
  incidents: Incident[];
  failedRuns: number;
  completedRuns: number;
};

const world: World = {
  reconcileErrors: [],
  reconcileCalls: 0,
  incidents: [],
  failedRuns: 0,
  completedRuns: 0,
};

const resetWorld = () => {
  world.reconcileErrors = [];
  world.reconcileCalls = 0;
  world.incidents = [];
  world.failedRuns = 0;
  world.completedRuns = 0;
};

/**
 * The shape Prisma produces when the server closes the connection mid-query:
 * a known-request error whose driver cause carries the Postgres SQLSTATE.
 */
const connectionDropped = () => {
  const error = new Error(
    "Invalid `prisma.chatCreditReservation.findMany()` invocation: Database error."
  ) as Error & { code?: string; cause?: unknown };
  error.name = "PrismaClientKnownRequestError";
  error.cause = {
    kind: "ConnectionClosed",
    originalCode: "08P01",
    originalMessage: "server conn crashed?",
  };
  return error;
};

const quiet = <T>(value: T) => async () => value;

let routePromise: Promise<
  typeof import("../../app/api/internal/maintenance/credit-reservations/route")
> | null = null;

const loadRoute = () => {
  if (!routePromise) {
    // The route reports incidents from `after()`, which needs a request scope
    // this harness does not have. Running the callback inline keeps the
    // assertion about *what* is reported, which is the contract under test.
    mock.module("next/server", {
      namedExports: { after: (callback: () => unknown) => callback() },
    });
    mock.module(mod("lib/chatSecurity.ts"), {
      namedExports: {
        reconcileExpiredChatCreditReservations: async () => {
          world.reconcileCalls += 1;
          const failure = world.reconcileErrors.shift();
          if (failure) throw failure;
          return { examined: 3, refunded: 1, alreadyFinalized: 2, failed: 0 };
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
        completeScheduledJob: async () => {
          world.completedRuns += 1;
        },
        failScheduledJob: async () => {
          world.failedRuns += 1;
        },
      },
    });
    mock.module(mod("lib/infrastructureThresholdMonitor.ts"), {
      namedExports: {
        monitorInfrastructureThresholdsIfDue: quiet({
          checked: false,
          alerts: 0,
          advisories: 0,
        }),
      },
    });
    mock.module(mod("lib/notificationDeliveryJob.ts"), {
      namedExports: { drainNotificationDeliveriesQuietly: quiet({ delivered: 0 }) },
    });
    mock.module(mod("lib/refundReconciliation.ts"), {
      namedExports: {
        reconcileProcessingRefundRequestsQuietly: quiet({ reconciled: 0 }),
      },
    });
    mock.module(mod("lib/chatRequestLease.ts"), {
      namedExports: { reconcileExpiredChatRequestLeases: quiet({ removed: 0 }) },
    });
    mock.module(mod("lib/imageAssetLifecycle.ts"), {
      namedExports: { runImageAssetMaintenanceQuietly: quiet({ deleted: 0 }) },
    });
    mock.module(mod("lib/generatedArtifactStorage.ts"), {
      namedExports: {
        runGeneratedArtifactMaintenanceQuietly: quiet({
          cleanup: { examined: 0, deleted: 0, failed: 0, exhausted: 0 },
          orphans: { examined: 0, deleted: 0, failed: 0 },
        }),
      },
    });
    mock.module(mod("lib/externalImportService.ts"), {
      namedExports: {
        reconcileExpiredExternalImportStaging: quiet({ expiredImports: 0 }),
      },
    });
    mock.module(mod("lib/memoryExpiryService.ts"), {
      namedExports: {
        reconcileExpiredMemories: quiet({ expiredMemories: 0, truncated: false }),
      },
    });
    mock.module(mod("lib/externalConversationLockService.ts"), {
      namedExports: {
        reconcileSourceLockedMemories: quiet({
          memoriesSuspended: 0,
          memoriesRestored: 0,
          memoriesExpired: 0,
          truncated: false,
        }),
      },
    });
    mock.module(mod("lib/memoryExtractionProviderCost.ts"), {
      namedExports: {
        reconcileUnsettledExtractionProviderCalls: quiet({ settled: 0 }),
      },
    });
    mock.module(mod("lib/memoryExtractionWorker.ts"), {
      namedExports: {
        dispatchPendingMemoryExtractionRuns: quiet({
          reclaimedRuns: 0,
          dispatchedRuns: 0,
          chunksProcessed: 0,
          skippedForTime: 0,
        }),
      },
    });
    process.env.MAINTENANCE_SECRET = MAINTENANCE_SECRET;
    routePromise = import(
      mod("app/api/internal/maintenance/credit-reservations/route.ts")
    ) as Promise<
      typeof import("../../app/api/internal/maintenance/credit-reservations/route")
    >;
  }
  return routePromise;
};

const post = async () => {
  const { POST } = await loadRoute();
  return POST(
    new Request("https://tomverse.app/api/internal/maintenance/credit-reservations", {
      method: "POST",
      headers: { Authorization: `Bearer ${MAINTENANCE_SECRET}` },
    })
  );
};

test("a dropped connection is retried, and the retry is an ordinary run", async () => {
  resetWorld();
  world.reconcileErrors = [connectionDropped()];

  const response = await post();

  assert.equal(response.status, 200);
  assert.equal(world.reconcileCalls, 2);
  assert.equal(world.completedRuns, 1);
  assert.equal(world.failedRuns, 0);
  // Nothing was broken, so nothing is reported.
  assert.deepEqual(world.incidents, []);
  assert.equal((await response.json()).success, true);
});

test("a drop that survives the retry defers instead of crashing the caller", async () => {
  resetWorld();
  world.reconcileErrors = [connectionDropped(), connectionDropped()];

  const response = await post();

  assert.equal(world.reconcileCalls, 2);
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("Retry-After"), "60");
  const body = await response.json();
  assert.equal(body.retryable, true);
  assert.equal(body.code, "CREDIT_RESERVATION_RECONCILIATION_DEFERRED");

  // Reported, so a database that stays unreachable is still loud -- but as a
  // deferral, not as the fatal "the reconciliation failed".
  assert.equal(world.incidents.length, 1);
  assert.equal(
    world.incidents[0].code,
    "CREDIT_RESERVATION_RECONCILIATION_DEFERRED"
  );
  assert.equal(world.incidents[0].severity, "error");
  assert.equal(world.incidents[0].context?.driverCode, "08P01");
  // The run is still recorded as failed: the sweep did not happen.
  assert.equal(world.failedRuns, 1);
  assert.equal(world.completedRuns, 0);
});

test("a failure that is not a connection drop keeps paging as fatal", async () => {
  resetWorld();
  world.reconcileErrors = [new Error("Reconciliation logic is wrong.")];

  const response = await post();

  // No retry: only a dropped connection earns one.
  assert.equal(world.reconcileCalls, 1);
  assert.equal(response.status, 500);
  assert.equal(response.headers.get("Retry-After"), null);
  assert.equal(world.incidents.length, 1);
  assert.equal(
    world.incidents[0].code,
    "CREDIT_RESERVATION_RECONCILIATION_FAILED"
  );
  assert.equal(world.incidents[0].severity, "fatal");
  assert.equal(world.failedRuns, 1);
});

test("an unauthorized caller is refused before any reconciliation runs", async () => {
  resetWorld();
  const { POST } = await loadRoute();

  const response = await POST(
    new Request(
      "https://tomverse.app/api/internal/maintenance/credit-reservations",
      { method: "POST", headers: { Authorization: "Bearer wrong-secret" } }
    )
  );

  assert.equal(response.status, 401);
  assert.equal(world.reconcileCalls, 0);
  assert.deepEqual(world.incidents, []);
});
