import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

/**
 * Snapshot-level contract for RAILWAY_USAGE_MONITOR_ENABLED.
 *
 * The incident this guards: production and staging point at the same Railway
 * Project-Access-Token, so their 15-minute Credit Reconciliation runs queried
 * `estimatedUsage` at the same moment and hit Railway's "16 concurrent usage
 * queries per client" limit. The switch must stop that one query in the
 * environment that opts out -- without touching credentials, without changing
 * production (which sets no variable at all), and without stopping the R2,
 * database or Prisma monitors that share the same dashboard call.
 *
 * Only Prisma and `fetch` are replaced. The snapshot module and the flag are
 * real.
 */

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relativePath: string) =>
  pathToFileURL(resolve(ROOT, relativePath)).href;

const RAILWAY_USAGE_URL = "https://backboard.railway.com/graphql/v2";
const CLOUDFLARE_URL = "https://api.cloudflare.com/client/v4/graphql";
// A full origin prefix rather than a bare host, matched with startsWith like
// the two above: a host substring would also match a URL that merely mentions
// it (https://evil.test/?x=api.prisma.io), which is both weaker as a test and
// the pattern CodeQL's js/incomplete-url-substring-sanitization flags.
const PRISMA_USAGE_URL_PREFIX = "https://api.prisma.io/";

// A value that must never appear in a snapshot, a message or this test's own
// output. Distinctive so a substring assertion is meaningful.
const RAILWAY_TOKEN = "railway-project-token-must-not-leak";

const requestedUrls: string[] = [];

const jsonResponse = (payload: unknown) =>
  new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const installFetchStub = () => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    requestedUrls.push(url);
    if (url.startsWith(RAILWAY_USAGE_URL)) {
      return jsonResponse({
        data: {
          estimatedUsage: [
            { measurement: "CPU_USAGE", estimatedValue: 120, projectId: "p_1" },
            {
              measurement: "MEMORY_USAGE_GB",
              estimatedValue: 60,
              projectId: "p_1",
            },
          ],
        },
      });
    }
    if (url.startsWith(CLOUDFLARE_URL)) {
      return jsonResponse({
        data: {
          viewer: {
            accounts: [
              {
                storage: [
                  {
                    max: {
                      objectCount: 12,
                      uploadCount: 0,
                      payloadSize: 2048,
                      metadataSize: 128,
                    },
                  },
                ],
                operations: [
                  { sum: { requests: 10 }, dimensions: { actionType: "PutObject" } },
                ],
              },
            ],
          },
        },
      });
    }
    if (url.startsWith(PRISMA_USAGE_URL_PREFIX)) {
      return jsonResponse({
        period: { start: "2026-08-01T00:00:00.000Z", end: "2026-08-04T00:00:00.000Z" },
        metrics: { operations: { used: 1_000 }, storage: { used: 0.5 } },
      });
    }
    throw new Error(`Unexpected fetch to ${url}`);
  }) as typeof fetch;
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
              creditMicroUsd: BigInt(5_000_000),
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

const withFlag = (value: string | undefined) => {
  requestedUrls.length = 0;
  process.env.RAILWAY_PROJECT_ID = "project_1";
  process.env.RAILWAY_PROJECT_TOKEN = RAILWAY_TOKEN;
  delete process.env.RAILWAY_API_TOKEN;
  delete process.env.RAILWAY_WORKSPACE_ID;
  process.env.R2_ACCOUNT_ID = "account_1";
  process.env.R2_BUCKET_NAME = "bucket_1";
  process.env.R2_ACCESS_KEY_ID = "r2-key";
  process.env.R2_SECRET_ACCESS_KEY = "r2-secret";
  process.env.CLOUDFLARE_API_TOKEN = "cloudflare-token";
  process.env.PRISMA_MANAGEMENT_API_TOKEN = "prisma-token";
  process.env.PRISMA_DATABASE_ID = "database_1";
  if (value === undefined) {
    delete process.env.RAILWAY_USAGE_MONITOR_ENABLED;
  } else {
    process.env.RAILWAY_USAGE_MONITOR_ENABLED = value;
  }
};

const railwayUsageQueries = () =>
  requestedUrls.filter((url) => url.startsWith(RAILWAY_USAGE_URL));

installFetchStub();

test("an unset flag queries Railway usage exactly as before", async () => {
  const { getInfrastructureDashboard } = await loadDashboard();
  withFlag(undefined);

  const dashboard = await getInfrastructureDashboard();

  assert.equal(railwayUsageQueries().length, 1);
  assert.equal(dashboard.railway.status, "healthy");
  assert.equal(dashboard.railway.measurements.length, 2);
  assert.ok((dashboard.railway.projectedMonthCostMicroUsd ?? 0) > 0);
});

test("an explicit true keeps Railway usage enabled", async () => {
  const { getInfrastructureDashboard } = await loadDashboard();
  for (const value of ["true", "TRUE", " true "]) {
    withFlag(value);
    const dashboard = await getInfrastructureDashboard();
    assert.equal(railwayUsageQueries().length, 1, value);
    assert.equal(dashboard.railway.status, "healthy", value);
  }
});

test("an unknown value keeps the existing enabled behaviour", async () => {
  const { getInfrastructureDashboard } = await loadDashboard();
  for (const value of ["", "   ", "0", "off", "no", "falsey"]) {
    withFlag(value);
    const dashboard = await getInfrastructureDashboard();
    assert.equal(railwayUsageQueries().length, 1, JSON.stringify(value));
    assert.equal(dashboard.railway.status, "healthy", JSON.stringify(value));
  }
});

test("false sends no estimatedUsage query, in any casing or padding", async () => {
  const { getInfrastructureDashboard } = await loadDashboard();
  for (const value of ["false", "FALSE", "False", " false ", "\tfalse\n"]) {
    withFlag(value);
    const dashboard = await getInfrastructureDashboard();
    assert.deepEqual(railwayUsageQueries(), [], JSON.stringify(value));
    assert.equal(dashboard.railway.status, "disabled", JSON.stringify(value));
  }
});

test("a disabled snapshot keeps configuration state and empties usage", async () => {
  const { getInfrastructureDashboard } = await loadDashboard();
  withFlag("false");

  const { railway } = await getInfrastructureDashboard();

  assert.equal(railway.status, "disabled");
  assert.equal(
    railway.message,
    "Railway usage monitoring is disabled for this environment."
  );
  // Safe configuration state survives, so an operator can still tell a
  // deliberate opt-out apart from a broken credential setup.
  assert.equal(railway.tokenConfigured, true);
  assert.equal(railway.scope, "project");
  assert.ok(Date.parse(railway.checkedAt) > 0);
  assert.equal(railway.configuredCreditMicroUsd, 5_000_000);
  assert.equal(railway.creditNote, "opening credit");
  // Usage-derived values are empty rather than stale.
  assert.deepEqual(railway.measurements, []);
  assert.equal(railway.projectedMonthCostMicroUsd, null);
  assert.equal(railway.projectedBalanceMicroUsd, null);
  assert.deepEqual(railway.warningReasons, []);
  assert.deepEqual(railway.apiRateLimit, {
    limit: null,
    remaining: null,
    resetAt: null,
  });
  // No token value reaches the snapshot the Admin UI renders.
  assert.equal(JSON.stringify(railway).includes(RAILWAY_TOKEN), false);
});

test("disabling Railway usage leaves R2, database and Prisma monitors running", async () => {
  const { getInfrastructureDashboard } = await loadDashboard();
  withFlag("false");

  const dashboard = await getInfrastructureDashboard();

  assert.equal(
    requestedUrls.some((url) => url.startsWith(CLOUDFLARE_URL)),
    true
  );
  assert.equal(
    requestedUrls.some((url) => url.startsWith(PRISMA_USAGE_URL_PREFIX)),
    true
  );
  assert.equal(dashboard.r2.status, "healthy");
  assert.equal(dashboard.prismaUsage.status, "healthy");
  assert.equal(dashboard.database.status, "healthy");
});

test("a disabled snapshot is not the unconfigured missing-token state", async () => {
  const { getInfrastructureDashboard } = await loadDashboard();
  withFlag(undefined);
  delete process.env.RAILWAY_PROJECT_TOKEN;

  const enabledWithoutToken = await getInfrastructureDashboard();

  assert.equal(enabledWithoutToken.railway.status, "unconfigured");
  assert.deepEqual(railwayUsageQueries(), []);

  withFlag("false");
  const disabled = await getInfrastructureDashboard();
  assert.equal(disabled.railway.status, "disabled");
});
