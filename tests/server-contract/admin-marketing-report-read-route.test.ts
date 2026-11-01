import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mock, test } from "node:test";

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relative: string) => pathToFileURL(resolve(ROOT, relative)).href;

type ReportRow = {
  id: string;
  kind: string;
  periodStart: Date;
  periodEnd: Date;
  sourceVersion: string;
  createdAt: Date;
  payload: unknown;
};

const world: {
  session: { user: { id: string } } | null;
  authorized: boolean;
  report: ReportRow | null;
  competitors: Array<{ id: string; displayName: string }>;
  reportQueries: string[];
  competitorQueries: string[][];
} = {
  session: { user: { id: "admin-1" } },
  authorized: true,
  report: null,
  competitors: [],
  reportQueries: [],
  competitorQueries: [],
};

const reset = () => {
  world.session = { user: { id: "admin-1" } };
  world.authorized = true;
  world.report = null;
  world.competitors = [];
  world.reportQueries = [];
  world.competitorQueries = [];
};

let installed = false;

async function loadRoute(): Promise<{
  GET: (request: Request, context: { params: Promise<{ reportId: string }> }) => Promise<Response>;
}> {
  if (!installed) {
    installed = true;
    mock.module("next-auth/next", {
      namedExports: { getServerSession: async () => world.session },
    });
    mock.module(mod("lib/auth.ts"), { namedExports: { authOptions: {} } });
    mock.module(mod("lib/adminAuth.ts"), {
      namedExports: { isAdminSession: () => world.authorized },
    });
    mock.module(mod("lib/apiSecurity.ts"), {
      namedExports: { consumeApiRateLimit: async () => undefined, apiSecurityResponse: () => null },
    });
    mock.module(mod("lib/prisma.ts"), {
      namedExports: {
        prisma: {
          marketingReport: {
            findUnique: async ({ where }: { where: { id: string } }) => {
              world.reportQueries.push(where.id);
              return world.report && world.report.id === where.id ? world.report : null;
            },
          },
          marketingCompetitor: {
            findMany: async ({ where }: { where: { id: { in: string[] } } }) => {
              world.competitorQueries.push(where.id.in);
              return world.competitors.filter((row) => where.id.in.includes(row.id));
            },
          },
        },
      },
    });
  }
  return import(mod("app/api/admin/marketing/reports/[reportId]/route.ts"));
}

const call = async (reportId: string) => {
  const { GET } = await loadRoute();
  return GET(new Request(`https://tomverse.app/api/admin/marketing/reports/${reportId}`), {
    params: Promise.resolve({ reportId }),
  });
};

const row = (kind: string, payload: unknown, id = "rep1"): ReportRow => ({
  id,
  kind,
  periodStart: new Date("2026-10-26T00:00:00.000Z"),
  periodEnd: new Date("2026-11-01T00:00:00.000Z"),
  sourceVersion: "v1",
  createdAt: new Date("2026-11-01T01:00:00.000Z"),
  payload,
});

const marketIntel = {
  facts: [
    {
      competitorId: "acme",
      factType: "plan_price",
      value: { kind: "money", amountMinor: 2000, currency: "USD" },
      sourceUrl: "https://acme.example/pricing",
      checkedAt: "2026-11-01T00:30:00Z",
    },
    {
      competitorId: "acme",
      factType: "plan_tier",
      value: { kind: "token", value: "pro" },
      sourceUrl: "https://acme.example/pricing",
      checkedAt: "2026-11-01T00:30:00Z",
    },
  ],
  unrepresentableFactCount: 3,
};

test("a person who is not an admin gets 404 and nothing is read", async () => {
  for (const setup of [() => (world.session = null), () => (world.authorized = false)]) {
    reset();
    world.report = row("market_intel", marketIntel);
    setup();
    const response = await call("rep1");
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "Not found." });
    assert.deepEqual(world.reportQueries, []);
  }
});

test("an id that is not an id never reaches the database", async () => {
  reset();
  const response = await call("not%20an%20id");
  assert.equal(response.status, 404);
  assert.deepEqual(world.reportQueries, []);
});

test("an id with no report is 404", async () => {
  reset();
  const response = await call("nothere");
  assert.equal(response.status, 404);
  assert.deepEqual(world.reportQueries, ["nothere"]);
});

test("a payload that does not parse as its kind is unreadable, not shown", async () => {
  reset();
  world.report = row("weekly_kpi", { postsPublished: "many" });
  const response = await call("rep1");
  assert.equal(response.status, 422);
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(body.code, "unreadable");
  assert.equal("payload" in body, false);

  // A kind this build does not know is the same answer.
  world.report = row("something_new", {});
  assert.equal((await call("rep1")).status, 422);
});

test("market_intel comes back parsed, with the competitor's display name", async () => {
  reset();
  world.report = row("market_intel", marketIntel);
  world.competitors = [
    { id: "acme", displayName: "Acme AI" },
    { id: "other", displayName: "Not in this report" },
  ];
  const response = await call("rep1");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(body.kind, "market_intel");
  assert.equal(body.periodStart, "2026-10-26T00:00:00.000Z");
  assert.deepEqual(body.competitorNames, { acme: "Acme AI" });
  assert.deepEqual(body.payload, marketIntel);
  assert.deepEqual(world.competitorQueries, [["acme"]]);
});

test("a competitor the registry no longer has is left out of the name map", async () => {
  reset();
  world.report = row("market_intel", marketIntel);
  const body = (await (await call("rep1")).json()) as { competitorNames: unknown };
  assert.deepEqual(body.competitorNames, {});
});

test("weekly_kpi comes back parsed and asks for no competitor names", async () => {
  reset();
  const weekly = {
    postsPublished: 4,
    postsRejected: 1,
    guardRejectionsByCode: [{ code: "claim_unbacked", count: 2 }],
    channelTotals: [{ accountSlug: "linkedin-1", published: 4, failed: 0 }],
  };
  world.report = row("weekly_kpi", weekly);
  const response = await call("rep1");
  assert.equal(response.status, 200);
  const body = (await response.json()) as { payload: unknown; competitorNames: unknown };
  assert.deepEqual(body.payload, weekly);
  assert.deepEqual(body.competitorNames, {});
  assert.deepEqual(world.competitorQueries, []);
});
