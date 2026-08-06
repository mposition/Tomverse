// Contract: the group polling route authenticates before it touches anything
// else, and a failure past authentication answers with a JSON 500 rather than
// leaking an exception. Ownership is covered by the DB integration suite; this
// file proves the route's ordering with no database at all.

import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(ROOT, path)).href;
const require = createRequire(import.meta.url);

process.env.E2E_DISABLE_DATABASE = "true";
process.env.NEXTAUTH_URL ||= "http://127.0.0.1:3100";
process.env.DATABASE_URL ||=
  "postgresql://e2e:e2e@127.0.0.1:1/e2e?connect_timeout=1";
process.env.NEXTAUTH_SECRET ||= "image-group-contract-2026";

let sessionOverride: unknown = null;
let mocksInstalled = false;

async function loadRoute() {
  if (mocksInstalled) {
    return import(mod("app/api/images/groups/[groupId]/route.ts"));
  }
  mocksInstalled = true;
  const realApiSecurity = require(
    resolve(ROOT, "lib/apiSecurity.ts")
  ) as Record<string, unknown>;
  mock.module("next-auth/next", {
    namedExports: { getServerSession: async () => sessionOverride },
  });
  mock.module(mod("lib/apiSecurity.ts"), {
    namedExports: {
      ...realApiSecurity,
      consumeApiRateLimit: async () => undefined,
    },
  });
  return import(mod("app/api/images/groups/[groupId]/route.ts"));
}

const getRequest = () =>
  new Request("http://127.0.0.1:3100/api/images/groups/group-1", {
    method: "GET",
  });
const params = { params: Promise.resolve({ groupId: "group-1" }) };

test("no session is rejected before any database access", async () => {
  sessionOverride = null;
  const { GET } = await loadRoute();
  const response = await GET(getRequest(), params);
  assert.equal(response.status, 401);
  const payload = await response.json();
  assert.equal(payload.error, "Authentication required.");
});

test("a database failure past authentication is a JSON 500, not a crash", async () => {
  sessionOverride = { user: { id: "user-contract-1" } };
  const { GET } = await loadRoute();
  const response = await GET(getRequest(), params);
  assert.equal(response.status, 500);
  const payload = await response.json();
  assert.equal(typeof payload.error, "string");
  // The group id the caller named is never echoed back on an error: a route
  // that repeats an id it could not read invites probing for which ids exist.
  assert.ok(!JSON.stringify(payload).includes("group-1"));
});
