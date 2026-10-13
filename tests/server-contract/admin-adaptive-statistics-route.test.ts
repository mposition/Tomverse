import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mock, test } from "node:test";

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;
let session: { user: { id: string } } | null = null;
let role: string | null = null;
const windows: number[] = [];

mock.module(mod("node_modules/next-auth/next/index.js"), {
  namedExports: { getServerSession: async () => session },
});
mock.module(mod("lib/auth.ts"), { namedExports: { authOptions: {} } });
mock.module(mod("lib/adminAuth.ts"), { namedExports: { getAdminRole: () => role } });
mock.module(mod("lib/apiSecurity.ts"), {
  namedExports: { consumeApiRateLimit: async () => {}, apiSecurityResponse: () => null },
});
mock.module(mod("lib/adaptiveStatisticsReport.ts"), {
  namedExports: { getAdaptiveStatisticsReport: async (days: number) => {
    windows.push(days);
    return { windowDays: days, coverage: { allChatTurns: null }, refiner: { requests: 0 } };
  } },
});

const loadRoute = async (): Promise<{ GET: (request: Request) => Promise<Response> }> =>
  import(mod("app/api/admin/chat/adaptive-statistics/route.ts"));
const request = (query = "") => new Request(`https://tomverse.app/api/admin/chat/adaptive-statistics${query}`);

test("only the owner may read actual execution statistics", async () => {
  const { GET } = await loadRoute();
  session = null;
  role = null;
  assert.equal((await GET(request())).status, 404);
  session = { user: { id: "admin" } };
  role = "readonly";
  assert.equal((await GET(request())).status, 404);
  assert.equal(windows.length, 0);
});

test("window is exact, invalid windows are rejected, and response is uncached", async () => {
  const { GET } = await loadRoute();
  session = { user: { id: "owner" } };
  role = "owner";
  assert.equal((await GET(request("?days=1"))).status, 400);
  assert.equal(windows.length, 0);
  const response = await GET(request("?days=30"));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(windows, [30]);
  const body = await response.json();
  assert.equal(body.coverage.allChatTurns, null);
});
