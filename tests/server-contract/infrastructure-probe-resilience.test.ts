import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

import { planInfrastructureAlerts } from "../../lib/infrastructureAlertPolicy.ts";

/**
 * Snapshot-level contract for what a failed usage read is allowed to claim.
 *
 * The incident this guards: the three usage probes are single-shot reads of
 * third-party billing telemetry on a fifteen-minute cadence, and any failure
 * at all was reported as `error` -- which
 * `planInfrastructureAlerts` turns into a *fatal* INFRASTRUCTURE_*_ERROR
 * incident. One flaky second on Railway or Prisma therefore paged Sentry,
 * Slack and email claiming the infrastructure was down. Production saw
 * exactly that: "Prisma Management API returned 500.", "The operation was
 * aborted due to timeout", and Railway's own usage throttle.
 *
 * Two rules hold here, and they pull in opposite directions on purpose:
 *
 *   * a transient failure -- timeout, socket error, 5xx, throttle -- is
 *     retried once and then reported as a `warning`, which still alerts but
 *     does not claim an outage, and
 *   * an actionable failure -- a rejected token, a wrong scope, a malformed
 *     response -- is never retried and never downgraded.
 *
 * Only Prisma and `fetch` are replaced. The snapshot module, the flag and the
 * alert policy are real.
 */

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relativePath: string) =>
  pathToFileURL(resolve(ROOT, relativePath)).href;

const RAILWAY_USAGE_URL = "https://backboard.railway.com/graphql/v2";
const CLOUDFLARE_URL = "https://api.cloudflare.com/client/v4/graphql";
const PRISMA_USAGE_URL_PREFIX = "https://api.prisma.io/";

type Handler = (url: string) => Promise<Response> | Response;

const attempts = { railway: 0, cloudflare: 0, prisma: 0 };

const jsonResponse = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });

const healthyRailway = () =>
  jsonResponse({
    data: {
      estimatedUsage: [
        { measurement: "CPU_USAGE", estimatedValue: 10, projectId: "p_1" },
      ],
    },
  });

const healthyCloudflare = () =>
  jsonResponse({
    data: {
      viewer: {
        accounts: [
          {
            storage: [
              {
                max: {
                  objectCount: 1,
                  uploadCount: 0,
                  payloadSize: 1_024,
                  metadataSize: 16,
                },
              },
            ],
            operations: [
              {
                sum: { requests: 1 },
                dimensions: { actionType: "PutObject" },
              },
            ],
          },
        ],
      },
    },
  });

const healthyPrisma = () =>
  jsonResponse({
    period: { start: "2026-08-01T00:00:00.000Z", end: "2026-08-10T00:00:00.000Z" },
    metrics: { operations: { used: 1_000 }, storage: { used: 0.5 } },
  });

const handlers: { railway: Handler; cloudflare: Handler; prisma: Handler } = {
  railway: healthyRailway,
  cloudflare: healthyCloudflare,
  prisma: healthyPrisma,
};

globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
  if (url.startsWith(RAILWAY_USAGE_URL)) {
    attempts.railway += 1;
    return handlers.railway(url);
  }
  if (url.startsWith(CLOUDFLARE_URL)) {
    attempts.cloudflare += 1;
    return handlers.cloudflare(url);
  }
  if (url.startsWith(PRISMA_USAGE_URL_PREFIX)) {
    attempts.prisma += 1;
    return handlers.prisma(url);
  }
  throw new Error(`Unexpected fetch to ${url}`);
}) as typeof fetch;

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
          providerErrorEvent: { count },
        },
      },
    });
    dashboardPromise = import(
      mod("lib/infrastructureMonitoring.ts")
    ) as Promise<typeof import("../../lib/infrastructureMonitoring")>;
  }
  return dashboardPromise;
};

const configureEnvironment = () => {
  attempts.railway = 0;
  attempts.cloudflare = 0;
  attempts.prisma = 0;
  handlers.railway = healthyRailway;
  handlers.cloudflare = healthyCloudflare;
  handlers.prisma = healthyPrisma;
  delete process.env.RAILWAY_USAGE_MONITOR_ENABLED;
  process.env.RAILWAY_PROJECT_ID = "project_1";
  process.env.RAILWAY_PROJECT_TOKEN = "railway-project-token";
  delete process.env.RAILWAY_API_TOKEN;
  delete process.env.RAILWAY_WORKSPACE_ID;
  process.env.R2_ACCOUNT_ID = "account_1";
  process.env.R2_BUCKET_NAME = "bucket_1";
  process.env.R2_ACCESS_KEY_ID = "r2-key";
  process.env.R2_SECRET_ACCESS_KEY = "r2-secret";
  process.env.CLOUDFLARE_API_TOKEN = "cloudflare-token";
  process.env.PRISMA_MANAGEMENT_API_TOKEN = "prisma-token";
  process.env.PRISMA_DATABASE_ID = "database_1";
};

const reasonCodes = (
  reasons: ReadonlyArray<{ code: string }> | undefined
) => (reasons || []).map((reason) => reason.code);

test("a 5xx on the first read is retried, and the retry is what counts", async () => {
  const { getInfrastructureDashboard } = await loadDashboard();
  configureEnvironment();
  handlers.prisma = () =>
    attempts.prisma === 1
      ? jsonResponse({ error: { message: "internal" } }, 500)
      : healthyPrisma();

  const dashboard = await getInfrastructureDashboard();

  assert.equal(attempts.prisma, 2);
  assert.equal(dashboard.prismaUsage.status, "healthy");
  assert.equal(dashboard.prismaUsage.operationsUsed, 1_000);
});

test("a 5xx that survives the retry is a warning, not a fatal outage", async () => {
  const { getInfrastructureDashboard } = await loadDashboard();
  configureEnvironment();
  handlers.prisma = () => jsonResponse({}, 500);

  const dashboard = await getInfrastructureDashboard();

  assert.equal(attempts.prisma, 2);
  assert.equal(dashboard.prismaUsage.status, "warning");
  assert.deepEqual(reasonCodes(dashboard.prismaUsage.warningReasons), [
    "PRISMA_USAGE_API_UNAVAILABLE",
  ]);
  assert.match(dashboard.prismaUsage.message, /returned 500/);
  // The reading stays absent rather than being reported as zero usage.
  assert.equal(dashboard.prismaUsage.operationsUsed, null);
});

test("the upstream's own error message survives the failure path", async () => {
  const { getInfrastructureDashboard } = await loadDashboard();
  configureEnvironment();
  handlers.prisma = () =>
    jsonResponse({ error: { message: "Usage service is restarting." } }, 503);

  const dashboard = await getInfrastructureDashboard();

  assert.equal(dashboard.prismaUsage.status, "warning");
  assert.equal(dashboard.prismaUsage.message, "Usage service is restarting.");
});

test("a timeout is transient: retried once, then a warning", async () => {
  const { getInfrastructureDashboard } = await loadDashboard();
  configureEnvironment();
  handlers.railway = () => {
    const error = new Error("The operation was aborted due to timeout");
    error.name = "TimeoutError";
    throw error;
  };

  const dashboard = await getInfrastructureDashboard();

  assert.equal(attempts.railway, 2);
  assert.equal(dashboard.railway.status, "warning");
  assert.deepEqual(reasonCodes(dashboard.railway.warningReasons), [
    "RAILWAY_USAGE_API_UNAVAILABLE",
  ]);
  assert.equal(dashboard.railway.projectedMonthCostMicroUsd, null);
});

test("Railway's usage throttle is a warning and is never retried", async () => {
  const { getInfrastructureDashboard } = await loadDashboard();
  configureEnvironment();
  // Verbatim shape: HTTP 200 with the limit in the GraphQL `errors` array.
  handlers.railway = () =>
    jsonResponse({
      errors: [
        {
          message:
            "Too many usage queries are running at once. Please retry in 120 seconds. Limit: 16 concurrent usage queries per client.",
        },
      ],
    });

  const dashboard = await getInfrastructureDashboard();

  // Asking again inside the same request only deepens the limit it reported.
  assert.equal(attempts.railway, 1);
  assert.equal(dashboard.railway.status, "warning");
  assert.deepEqual(reasonCodes(dashboard.railway.warningReasons), [
    "RAILWAY_USAGE_API_UNAVAILABLE",
  ]);
});

test("a rejected credential is actionable: no retry, still an error", async () => {
  const { getInfrastructureDashboard } = await loadDashboard();
  configureEnvironment();
  handlers.railway = () =>
    jsonResponse({ errors: [{ message: "Not Authorized" }] }, 401);
  handlers.prisma = () =>
    jsonResponse({ error: { message: "Invalid API token." } }, 401);

  const dashboard = await getInfrastructureDashboard();

  assert.equal(attempts.railway, 1);
  assert.equal(attempts.prisma, 1);
  assert.equal(dashboard.railway.status, "error");
  assert.deepEqual(reasonCodes(dashboard.railway.warningReasons), [
    "RAILWAY_API_ERROR",
  ]);
  assert.equal(dashboard.prismaUsage.status, "error");
  assert.deepEqual(reasonCodes(dashboard.prismaUsage.warningReasons), [
    "PRISMA_API_ERROR",
  ]);
});

test("a response missing the reading it was asked for stays an error", async () => {
  const { getInfrastructureDashboard } = await loadDashboard();
  configureEnvironment();
  handlers.prisma = () => jsonResponse({ metrics: { storage: { used: 1 } } });

  const dashboard = await getInfrastructureDashboard();

  assert.equal(attempts.prisma, 1);
  assert.equal(dashboard.prismaUsage.status, "error");
  assert.deepEqual(reasonCodes(dashboard.prismaUsage.warningReasons), [
    "PRISMA_API_ERROR",
  ]);
});

test("the R2 analytics read follows the same split", async () => {
  const { getInfrastructureDashboard } = await loadDashboard();
  configureEnvironment();
  handlers.cloudflare = () => jsonResponse({}, 502);

  const unavailable = await getInfrastructureDashboard();
  assert.equal(attempts.cloudflare, 2);
  assert.equal(unavailable.r2.status, "warning");
  assert.deepEqual(reasonCodes(unavailable.r2.warningReasons), [
    "R2_USAGE_API_UNAVAILABLE",
  ]);

  configureEnvironment();
  handlers.cloudflare = () =>
    jsonResponse({ errors: [{ message: "Authentication error" }] });

  const rejected = await getInfrastructureDashboard();
  assert.equal(attempts.cloudflare, 1);
  assert.equal(rejected.r2.status, "error");
  assert.deepEqual(reasonCodes(rejected.r2.warningReasons), ["R2_API_ERROR"]);
});

test("a transient probe warning still alerts, only not as an outage", async () => {
  const { getInfrastructureDashboard } = await loadDashboard();
  configureEnvironment();
  handlers.railway = () => jsonResponse({}, 500);

  const dashboard = await getInfrastructureDashboard();
  const plan = planInfrastructureAlerts(dashboard);

  // Not suppressed: the operator still hears about it. The claim is what
  // changed -- a warning instead of "railway infrastructure is error".
  assert.equal(plan.advisories.length, 0);
  assert.deepEqual(
    plan.incidents.map((incident) => [incident.code, incident.severity]),
    [["INFRASTRUCTURE_RAILWAY_WARNING", "warning"]]
  );
});

test("a healthy dashboard is unchanged: one read each, no incidents", async () => {
  const { getInfrastructureDashboard } = await loadDashboard();
  configureEnvironment();

  const dashboard = await getInfrastructureDashboard();

  assert.deepEqual(attempts, { railway: 1, cloudflare: 1, prisma: 1 });
  assert.equal(dashboard.railway.status, "healthy");
  assert.equal(dashboard.r2.status, "healthy");
  assert.equal(dashboard.prismaUsage.status, "healthy");
  assert.equal(planInfrastructureAlerts(dashboard).incidents.length, 0);
});
