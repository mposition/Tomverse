import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mock, test } from "node:test";

// The weekly marketing report's route (owner request 2026-11-03): admin only,
// read only, a Brisbane Monday that has begun, assembled from the tables.

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relative: string) => pathToFileURL(resolve(ROOT, relative)).href;

const world: {
  session: { user: { id: string } } | null;
  authorized: boolean;
  queries: number;
  analysis: { payload: unknown; briefReportId: string; createdAt: Date } | null;
} = {
  session: { user: { id: "admin-1" } },
  authorized: true,
  queries: 0,
  analysis: null,
};

const reset = () => {
  world.session = { user: { id: "admin-1" } };
  world.authorized = true;
  world.queries = 0;
  world.analysis = null;
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
          // Every table empty -- no post, report or event -- except the week's
          // newest analysis when a test sets one.
          $queryRaw: async (query: { sql?: string; strings?: readonly string[] }) => {
            world.queries += 1;
            const text = query?.sql ?? query?.strings?.join("?") ?? "";
            if (world.analysis && text.includes('SELECT "payload", "briefReportId", "createdAt" FROM "MarketingAnalysis"')) {
              return [world.analysis];
            }
            return [];
          },
          marketingCompetitor: { findMany: async () => [{ officialHosts: ["poe.com"] }] },
        },
      },
    });
  }
  return import(mod("app/api/admin/marketing/weekly-report/route.ts"));
}

// Weeks relative to today, so the test does not age out of the readable range.
const DAY_MS = 24 * 60 * 60 * 1000;
const monday = (offsetWeeks: number) => {
  const local = Date.now() + 10 * 60 * 60 * 1000;
  const midnight = local - (local % DAY_MS);
  const sinceMonday = (new Date(midnight).getUTCDay() + 6) % 7;
  return new Date(midnight - sinceMonday * DAY_MS + offsetWeeks * 7 * DAY_MS).toISOString().slice(0, 10);
};
const LAST = monday(-1);

const request = (week?: string) =>
  new Request(`https://tomverse.test/api/admin/marketing/weekly-report${week ? `?week=${week}` : ""}`);

test("a person who is not an admin is told nothing and nothing is read", async () => {
  reset();
  const { GET } = await loadRoute();
  world.authorized = false;
  const response = await GET(request(LAST));
  assert.equal(response.status, 404);
  assert.equal(world.queries, 0);
});

test("a date that is not a Monday, a week not begun, or one past retention, is not a report", async () => {
  reset();
  const { GET } = await loadRoute();
  assert.equal((await GET(request("2026-10-27"))).status, 404);
  assert.equal((await GET(request("2099-01-05"))).status, 404);
  // Past the shortest retention, a week would show deletions as zeros.
  assert.equal((await GET(request(monday(-20)))).status, 404);
  assert.equal(world.queries, 0);
});

test("an empty week reads as counted zeros, held metrics and nothing written", async () => {
  reset();
  const { GET } = await loadRoute();
  const response = await GET(request(LAST));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const body = await response.json();
  assert.equal(body.weekStart, LAST);
  assert.equal(body.previousWeekStart, monday(-2));
  assert.equal(body.nextWeekStart, monday(0));
  // The oldest readable week offers no earlier one.
  const oldest = await (await GET(request(monday(-11)))).json();
  assert.equal(oldest.weekStart, monday(-11));
  assert.equal(oldest.previousWeekStart, null);
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

test("the week's analysis is shown with its sources judged against the approved hosts", async () => {
  reset();
  const { GET } = await loadRoute();
  world.analysis = {
    briefReportId: "brief-1",
    createdAt: new Date("2026-10-28T21:05:00.000Z"),
    payload: {
      promptVersion: "analysis-v1",
      self: { summary: "s", strengths: ["a"], weaknesses: ["b"], audiences: ["c"] },
      competitive: {
        pricePosition: "p",
        ahead: [{ point: "x", sources: ["https://poe.com/pricing", "https://made-up.example/"] }],
        behind: [],
        weeklyMessage: "w",
      },
      topicId: "side-by-side-answers",
      claimIds: ["claim.review-three-models"],
      competitorIds: ["poe"],
      factCount: 1,
      featureCount: 0,
    },
  };
  const body = await (await GET(request(LAST))).json();
  assert.equal(body.analysis.topicId, "side-by-side-answers");
  assert.equal(body.analysis.createdAt, "2026-10-28T21:05:00.000Z");
  assert.deepEqual(
    body.analysis.competitive.ahead[0].sources.map((source: { linkable: boolean }) => source.linkable),
    [true, false],
  );
});
