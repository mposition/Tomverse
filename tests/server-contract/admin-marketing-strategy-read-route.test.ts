import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mock, test } from "node:test";

// The weekly plan's read route (owner request 2026-11-03): admin only, read
// only, and a stored plan that no longer parses is unreadable, not drawn.

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relative: string) => pathToFileURL(resolve(ROOT, relative)).href;

type Row = { strategy: unknown; briefReportId: string; createdAt: Date };

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
  return import(mod("app/api/admin/marketing/strategy/route.ts"));
}

const request = () => new Request("https://tomverse.test/api/admin/marketing/strategy");

const STRATEGY = {
  promptVersion: "strategy-v1",
  weekStart: "2026-11-02",
  weekEnd: "2026-11-08",
  headline: "구독 여러 개 대신 한 화면에서 비교",
  rationale: "대형 3사가 모두 월 US$20 선이다.",
  goal: "계정별 반응 기준선을 만든다.",
  accounts: [
    {
      accountSlug: "instagram-3",
      role: "한국어 인지도",
      angle: "같은 질문, 세 답",
      format: "숏폼 영상",
      posts: 3,
      days: ["tue", "thu", "sat"],
      claimIds: ["claim.review-three-models"],
      assetIds: [],
    },
  ],
  needs: [],
  avoid: ["경쟁사 이름을 쓰지 않는다"],
};

test("a person who is not an admin is told nothing and nothing is read", async () => {
  reset();
  const { GET } = await loadRoute();
  world.authorized = false;
  const response = await GET(request());
  assert.equal(response.status, 404);
  assert.equal(world.queries, 0);
});

test("no stored plan reads as none", async () => {
  reset();
  const { GET } = await loadRoute();
  const response = await GET(request());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "none" });
});

test("the newest plan is returned with its week, and an unparseable one is unreadable", async () => {
  reset();
  const { GET } = await loadRoute();
  world.rows = [{ strategy: STRATEGY, briefReportId: "brief-1", createdAt: new Date("2026-11-02T21:05:00.000Z") }];
  const found = await GET(request());
  assert.equal(found.status, 200);
  assert.equal(found.headers.get("cache-control"), "private, no-store");
  const body = await found.json();
  assert.equal(body.status, "found");
  assert.equal(body.briefReportId, "brief-1");
  assert.equal(body.createdAt, "2026-11-02T21:05:00.000Z");
  assert.deepEqual(body.strategy, STRATEGY);
  assert.equal(typeof body.current, "boolean");

  world.rows = [{ strategy: { ...STRATEGY, accounts: [] }, briefReportId: "brief-2", createdAt: new Date() }];
  const unreadable = await GET(request());
  assert.deepEqual(await unreadable.json(), { status: "unreadable" });
});
