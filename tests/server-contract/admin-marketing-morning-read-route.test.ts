import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mock, test } from "node:test";

// The morning report's read route (owner request 2026-11-03): admin only,
// read only, and a stored report that no longer parses is unreadable.

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relative: string) => pathToFileURL(resolve(ROOT, relative)).href;

type Row = { morning: unknown; briefReportId: string; createdAt: Date };

const world: { session: { user: { id: string } } | null; authorized: boolean; rows: Row[]; queries: number } = {
  session: { user: { id: "admin-1" } },
  authorized: true,
  rows: [],
  queries: 0,
};

const reset = () => {
  world.session = { user: { id: "admin-1" } };
  world.authorized = true;
  world.rows = [];
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
          $queryRaw: async () => {
            world.queries += 1;
            return world.rows;
          },
        },
      },
    });
  }
  return import(mod("app/api/admin/marketing/morning/route.ts"));
}

const request = () => new Request("https://tomverse.test/api/admin/marketing/morning");

const MORNING = {
  promptVersion: "morning-v1",
  date: "2026-11-04",
  verdict: "아직 나간 게시물이 없습니다.",
  decisions: [{ title: "게시 스위치 켜기", why: "승인된 3건이 대기 중입니다.", section: "queue" }],
  worked: "판단 보류",
  adjust: [],
  marketChanges: [],
  figures: {
    published7d: 0,
    sent7d: 0,
    failed7d: 0,
    pendingApproval: 9,
    approvedWaiting: 3,
    nextApprovalExpiryAt: null,
    touches7d: 0,
    signupsAttributed7d: 0,
    llmCountedMicroUsd: 0,
    llmCapUsd: 100,
    publishEnabled: false,
  },
};

test("a person who is not an admin is told nothing and nothing is read", async () => {
  reset();
  const { GET } = await loadRoute();
  world.authorized = false;
  const response = await GET(request());
  assert.equal(response.status, 404);
  assert.equal(world.queries, 0);
});

test("no stored report reads as none", async () => {
  reset();
  const { GET } = await loadRoute();
  const response = await GET(request());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "none" });
});

test("the newest report is returned with its date, and an unparseable one is unreadable", async () => {
  reset();
  const { GET } = await loadRoute();
  world.rows = [{ morning: MORNING, briefReportId: "brief-1", createdAt: new Date("2026-11-02T21:05:00.000Z") }];
  const found = await GET(request());
  assert.equal(found.status, 200);
  assert.equal(found.headers.get("cache-control"), "private, no-store");
  const body = await found.json();
  assert.equal(body.status, "found");
  assert.equal(body.briefReportId, "brief-1");
  assert.equal(body.createdAt, "2026-11-02T21:05:00.000Z");
  assert.deepEqual(body.morning, MORNING);
  assert.equal(typeof body.current, "boolean");

  world.rows = [{ morning: { ...MORNING, decisions: [{ title: "x", why: "y", section: "admin" }] }, briefReportId: "brief-2", createdAt: new Date() }];
  const unreadable = await GET(request());
  assert.deepEqual(await unreadable.json(), { status: "unreadable" });
});
