// The owner's ops-observer genesis route (docs/policy/sre-ops.md §8, §9 D5b):
// a non-administrator is told nothing (404); an administrator without
// `sre-agent:write` is refused (403) before the sign-in or the body is read;
// a recent sign-in is required on every request; the closed body reaches the
// store as written; a store refusal is 409 with its code, a late run 409
// `late`; and nothing else leaves but a bare 500.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { before, beforeEach, mock, test } from "node:test";

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relative: string) => pathToFileURL(resolve(ROOT, relative)).href;
const require = createRequire(import.meta.url);

class OpsObserverLateError extends Error {}

const world = {
  session: null as unknown,
  isAdmin: false,
  canWrite: false,
  reauthentications: 0,
  stored: [] as unknown[],
  outcome: { result: "created", genesisId: "g", requestDigest: "d" } as unknown,
  throws: null as unknown,
};
let POST: (request: Request) => Promise<Response>;

before(async () => {
  mock.module(mod("node_modules/next-auth/next/index.js"), {
    namedExports: { getServerSession: async () => world.session },
  });
  mock.module(mod("lib/adminAuth.ts"), {
    namedExports: { isAdminSession: () => world.isAdmin, hasAdminPermission: () => world.canWrite },
  });
  const realReauthentication = require(resolve(ROOT, "lib/adminReauthentication.ts")) as Record<string, unknown>;
  mock.module(mod("lib/adminReauthentication.ts"), {
    namedExports: {
      ...realReauthentication,
      assertRecentAdminAuthentication: async () => {
        world.reauthentications += 1;
      },
    },
  });
  const realApiSecurity = require(resolve(ROOT, "lib/apiSecurity.ts")) as Record<string, unknown>;
  mock.module(mod("lib/apiSecurity.ts"), {
    namedExports: { ...realApiSecurity, consumeApiRateLimit: async () => {} },
  });
  mock.module(mod("lib/opsObserverTransaction.ts"), {
    namedExports: { OpsObserverLateError, isBudgetInsufficient: () => false },
  });
  mock.module(mod("lib/opsObserverStore.ts"), {
    namedExports: {
      createOpsObserverGenesis: async (input: Record<string, unknown>) => {
        const rest = { ...input };
        delete rest.session;
        delete rest.request;
        world.stored.push(rest);
        if (world.throws) throw world.throws;
        return world.outcome;
      },
    },
  });
  ({ POST } = await import(mod("app/api/admin/agents/sre-ops/genesis/route.ts")));
});

beforeEach(() => {
  world.session = { user: { id: "owner-1", email: "owner@example.test" } };
  world.isAdmin = true;
  world.canWrite = true;
  world.reauthentications = 0;
  world.stored = [];
  world.outcome = { result: "created", genesisId: "g", requestDigest: "d" };
  world.throws = null;
});

const BODY = {
  reason: "initial",
  mode: "shadow",
  expectedGenesisId: null,
  expectedGeneration: null,
  expectedMode: null,
  trustReason: "state_missing",
};
const call = (body: unknown) =>
  POST(new Request("https://tomverse.app/api/admin/agents/sre-ops/genesis", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));

test("a non-administrator is told nothing, and one without the permission is refused first", async () => {
  world.isAdmin = false;
  assert.equal((await call(BODY)).status, 404);
  world.isAdmin = true;
  world.canWrite = false;
  const response = await call(BODY);
  assert.equal(response.status, 403);
  assert.equal((await response.json()).code, "SRE_AGENT_WRITE_REQUIRED");
  assert.equal(world.reauthentications, 0);
  assert.deepEqual(world.stored, []);
});

test("the owner's closed body reaches the store after a recent sign-in", async () => {
  const response = await call(BODY);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, result: world.outcome });
  assert.equal(world.reauthentications, 1);
  assert.deepEqual(world.stored, [BODY]);
});

test("a body outside the closed shape is refused before the store", async () => {
  for (const body of [
    { ...BODY, extra: 1 },
    { ...BODY, reason: "rewind" },
    { ...BODY, trustReason: "fine" },
    { ...BODY, expectedGenesisId: "not-a-uuid" },
  ]) {
    assert.equal((await call(body)).status, 400, JSON.stringify(body));
  }
  assert.deepEqual(world.stored, []);
});

test("a store refusal is 409 with its code, a late run is 409 late, and anything else a bare 500", async () => {
  for (const result of ["stale", "genesis_too_soon", "transition_refused", "already_consumed"]) {
    world.outcome = { result };
    const response = await call(BODY);
    assert.deepEqual([response.status, (await response.json()).code], [409, result]);
  }
  world.throws = new OpsObserverLateError("ops_observer_late_commit");
  const late = await call(BODY);
  assert.deepEqual([late.status, (await late.json()).code], [409, "late"]);
  world.throws = Object.assign(new Error("connection to 10.0.0.4 failed for owner@example.test"), { code: "P1001" });
  const logged: string[] = [];
  const original = console.error;
  console.error = (line: string) => logged.push(line);
  try {
    const failed = await call(BODY);
    assert.equal(failed.status, 500);
    assert.ok(!(await failed.text()).includes("10.0.0.4"));
  } finally {
    console.error = original;
  }
  assert.deepEqual(JSON.parse(logged[0]), { event: "ops_observer_genesis_failed", errorName: "Error", errorCode: "P1001" });
});
