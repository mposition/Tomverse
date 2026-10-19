import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

// GET /api/chat/concurrency: the read the error card polls to enable its retry
// button once a running answer finishes. The lease counting itself is pinned in
// tests/integration/chat-concurrency.db.test.ts; this pins what the route makes
// of the counts -- signed-in callers are judged on their own scope only, guests
// on both, and the IP count never reaches the body.

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relativePath: string) =>
  pathToFileURL(resolve(ROOT, relativePath)).href;
const require = createRequire(import.meta.url);

process.env.E2E_DISABLE_DATABASE = "true";
process.env.DATABASE_URL ||=
  "postgresql://e2e:e2e@127.0.0.1:1/e2e?connect_timeout=1";
process.env.DIRECT_URL ||= process.env.DATABASE_URL;
process.env.NEXTAUTH_SECRET ||= "server-contract-test-secret";
process.env.NEXTAUTH_URL ||= "http://127.0.0.1:3100";
process.env.CHAT_USER_CONCURRENT = "3";
process.env.CHAT_GUEST_CONCURRENT = "3";
process.env.CHAT_IP_CONCURRENT = "24";

const world = {
  session: null as null | { user: { id: string } },
  counts: { subject: 0, ip: 0 },
  countedScopes: [] as string[],
};

let route: { GET: (request: Request) => Promise<Response> } | null = null;

const loadRoute = async () => {
  if (route) return route;
  const original = (path: string) =>
    require(resolve(ROOT, path)) as Record<string, unknown>;
  mock.module(mod("lib/chatRequestLease.ts"), {
    namedExports: {
      ...original("lib/chatRequestLease.ts"),
      countActiveLeases: async (_client: unknown, scope: { scope: "subject" | "ip" }) => {
        world.countedScopes.push(scope.scope);
        return world.counts[scope.scope];
      },
    },
  });
  mock.module(mod("lib/apiSecurity.ts"), {
    namedExports: {
      ...original("lib/apiSecurity.ts"),
      consumeApiRateLimit: async () => undefined,
    },
  });
  mock.module("next-auth/next", {
    namedExports: { getServerSession: async () => world.session },
  });
  route = (await import(`${mod("app/api/chat/concurrency/route.ts")}?spy=cached`)) as {
    GET: (request: Request) => Promise<Response>;
  };
  return route;
};

const read = async () => {
  const { GET } = await loadRoute();
  world.countedScopes = [];
  const response = await GET(new Request("http://127.0.0.1:3100/api/chat/concurrency"));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  return (await response.json()) as Record<string, unknown>;
};

test("a signed-in caller at the limit is told to wait, below it to go", async () => {
  world.session = { user: { id: "user-1" } };
  world.counts = { subject: 3, ip: 0 };
  assert.deepEqual(await read(), { available: false, activeRequests: 3, concurrentLimit: 3 });
  assert.deepEqual(world.countedScopes, ["subject"]);

  world.counts = { subject: 2, ip: 0 };
  assert.deepEqual(await read(), { available: true, activeRequests: 2, concurrentLimit: 3 });
});

test("a guest also waits on a full network, without learning how full it is", async () => {
  world.session = null;
  world.counts = { subject: 1, ip: 24 };
  const body = await read();
  assert.deepEqual(body, { available: false, activeRequests: 1, concurrentLimit: 3 });
  assert.deepEqual(world.countedScopes, ["subject", "ip"]);
  assert.equal(JSON.stringify(body).includes("24"), false);

  world.counts = { subject: 1, ip: 23 };
  assert.equal((await read()).available, true);
});
