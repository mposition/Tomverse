import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mock, test } from "node:test";

// The weekly marketing report's route (owner request 2026-11-03): admin only,
// read only, a Brisbane Monday that has begun, assembled from the tables.

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relative: string) => pathToFileURL(resolve(ROOT, relative)).href;

const world: { session: { user: { id: string } } | null; authorized: boolean; queries: number } = {
  session: { user: { id: "admin-1" } },
  authorized: true,
  queries: 0,
};

const reset = () => {
  world.session = { user: { id: "admin-1" } };
  world.authorized = true;
  world.queries = 0;
};

let installed = false;

async function loadRoute(): Promise<{ GET: (request: Request) => Promise<Response> }> {
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
          // Every table empty: no post, report, analysis or event.
          $queryRaw: async () => {
            world.queries += 1;
            return [];
          },
          marketingCompetitor: { findMany: async () => [] },
        },
      },
    });
  }
  return import(mod("app/api/admin/marketing/weekly-report/route.ts"));
}

const request = (week?: string) =>
  new Request(`https://tomverse.test/api/admin/marketing/weekly-report${week ? `?week=${week}` : ""}`);

test("a person who is not an admin is told nothing and nothing is read", async () => {
  reset();
  const { GET } = await loadRoute();
  world.authorized = false;
  const response = await GET(request("2026-10-26"));
  assert.equal(response.status, 404);
  assert.equal(world.queries, 0);
});

test("a date that is not a Monday, or a week not begun, is not a report", async () => {
  reset();
  const { GET } = await loadRoute();
  assert.equal((await GET(request("2026-10-27"))).status, 404);
  assert.equal((await GET(request("2099-01-05"))).status, 404);
  assert.equal(world.queries, 0);
});

test("an empty week reads as counted zeros, held metrics and nothing written", async () => {
  reset();
  const { GET } = await loadRoute();
  const response = await GET(request("2026-10-26"));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const body = await response.json();
  assert.equal(body.weekStart, "2026-10-26");
  assert.equal(body.weekEnd, "2026-11-01");
  assert.equal(body.previousWeekStart, "2026-10-19");
  assert.equal(body.nextWeekStart, "2026-11-02");
  assert.equal(body.measurement.dispatch.sent, 0);
  assert.deepEqual([...body.measurement.held].sort(), ["latency", "signups", "success_rate"]);
  assert.equal(body.analysis, null);
  assert.equal(body.strategy, null);
  assert.equal(body.weeklyKpiRecorded, false);

  // Without a week, the last full one.
  const latest = await (await GET(request())).json();
  assert.match(latest.weekStart, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(latest.inProgress, false);
});
