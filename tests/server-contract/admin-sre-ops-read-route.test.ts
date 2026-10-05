// The owner's read of the sre-ops chain (docs/policy/sre-ops.md §8): a
// non-administrator is told nothing and the store is not read; an
// administrator gets the view, no-store, without a step-up; a failing read is
// a bare 500 logged by name and code only.

import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { before, beforeEach, mock, test } from "node:test";

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relative: string) => pathToFileURL(resolve(ROOT, relative)).href;

const VIEW = {
  head: { genesisId: "00000000-0000-4000-8000-000000000001", generation: 3, mode: "shadow", createdAt: "2026-10-01T00:00:00.000Z" },
  trustReason: "trusted",
  nextGenesisAt: "2026-10-08T00:00:00.000Z",
  genesisAllowedNow: false,
};
const world = { session: null as unknown, isAdmin: false, reads: 0, throws: null as unknown };
let GET: () => Promise<Response>;

before(async () => {
  mock.module(mod("node_modules/next-auth/next/index.js"), {
    namedExports: { getServerSession: async () => world.session },
  });
  mock.module(mod("lib/adminAuth.ts"), {
    namedExports: { isAdminSession: () => world.isAdmin, hasAdminPermission: () => false },
  });
  mock.module(mod("lib/opsObserverStore.ts"), {
    namedExports: {
      readOpsObserverAdminView: async () => {
        world.reads += 1;
        if (world.throws) throw world.throws;
        return VIEW;
      },
    },
  });
  ({ GET } = await import(mod("app/api/admin/agents/sre-ops/route.ts")));
});

beforeEach(() => {
  world.session = { user: { id: "admin-1", email: "admin@example.test" } };
  world.isAdmin = true;
  world.reads = 0;
  world.throws = null;
});

test("a non-administrator is told nothing and nothing is read", async () => {
  world.isAdmin = false;
  const response = await GET();
  assert.equal(response.status, 404);
  assert.equal(world.reads, 0);
});

test("an administrator reads the view, no-store, with no step-up or write permission", async () => {
  const response = await GET();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { ok: true, view: VIEW });
});

test("a failing read is a bare 500 logged without its message", async () => {
  world.throws = Object.assign(new Error("connect to 10.0.0.4 failed"), { code: "P1001" });
  const logged: string[] = [];
  const original = console.error;
  console.error = (line: string) => logged.push(line);
  try {
    const response = await GET();
    assert.equal(response.status, 500);
    assert.ok(!(await response.text()).includes("10.0.0.4"));
  } finally {
    console.error = original;
  }
  assert.deepEqual(JSON.parse(logged[0]), { event: "ops_observer_admin_read_failed", errorName: "Error", errorCode: "P1001" });
});
