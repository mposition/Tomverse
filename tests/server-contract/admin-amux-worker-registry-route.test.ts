import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mock, test } from "node:test";

// Orchestration policy version 31, sections 3 and 8: the worker registry
// route. Reading is open to any administrator. A change needs the owner role,
// the stage's code latch and a recent step-up, all checked before the body is
// read; with the latch off (as R1 ships) nothing reaches the store. The store,
// the reader and the DB boundary are faked; the boundary around the real store
// is the agents lane's (tests/integration/amux-worker-registry.db.test.ts).

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relative: string) => pathToFileURL(resolve(ROOT, relative)).href;
const require = createRequire(import.meta.url);

class FakeBoundaryError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

class FakeWriteError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

type World = {
  session: { user: { id: string; authenticatedAt?: string } } | null;
  admin: boolean;
  role: string | null;
  latch: boolean;
  boundaries: string[];
  changes: unknown[];
  reads: number;
  boundaryError: Error | null;
  storeError: Error | null;
  readError: Error | null;
  budgetDepth: number;
};
let world: World;
const reset = (changes: Partial<World> = {}) => {
  world = {
    session: { user: { id: "owner-1", authenticatedAt: new Date().toISOString() } },
    admin: true,
    role: "owner",
    latch: true,
    boundaries: [],
    changes: [],
    reads: 0,
    boundaryError: null,
    storeError: null,
    readError: null,
    budgetDepth: 0,
    ...changes,
  };
};
reset();

const VIEW = { writesLatch: false, registryReadable: true, rows: [], comparison: { status: "match", rows: [] }, seed: [] };

type Route = {
  GET: (request: Request) => Promise<Response>;
  POST: (request: Request) => Promise<Response>;
};

let installed = false;
async function loadRoute(): Promise<Route> {
  if (!installed) {
    installed = true;
    mock.module("next-auth/next", {
      namedExports: { getServerSession: async () => world.session },
    });
    mock.module(mod("lib/auth.ts"), { namedExports: { authOptions: {} } });
    mock.module(mod("lib/adminAuth.ts"), {
      namedExports: {
        isAdminSession: () => world.admin,
        getAdminRole: () => world.role,
      },
    });
    const realApiSecurity = require(resolve(ROOT, "lib/apiSecurity.ts"));
    mock.module(mod("lib/apiSecurity.ts"), {
      namedExports: { ...realApiSecurity, consumeApiRateLimit: async () => {} },
    });
    mock.module(mod("lib/amux/dbBoundary.ts"), {
      namedExports: {
        AMUX_DB_BOUNDARIES: {
          workerRegistryRead: { operation: "worker_registry_read" },
          workerRegistryChange: { operation: "worker_registry_change" },
        },
        AmuxDbBoundaryError: FakeBoundaryError,
        withAmuxRouteBudget: async (work: () => Promise<unknown>) => {
          world.budgetDepth += 1;
          try {
            return await work();
          } finally {
            world.budgetDepth -= 1;
          }
        },
        withAmuxDbBoundary: async (
          boundary: { operation: string },
          work: (tx: unknown) => Promise<unknown>,
        ) => {
          assert.equal(world.budgetDepth, 1, "a boundary runs only inside the route budget");
          world.boundaries.push(boundary.operation);
          if (world.boundaryError) throw world.boundaryError;
          return work({ fake: "tx" });
        },
      },
    });
    mock.module(mod("lib/amux/workerRegistryCore.ts"), {
      namedExports: { amuxWorkerRegistryWritesOpen: () => world.latch },
    });
    mock.module(mod("lib/amux/workerRegistryAdminRead.ts"), {
      namedExports: {
        readAmuxWorkerRegistryForAdmin: async () => {
          world.reads += 1;
          if (world.readError) throw world.readError;
          return VIEW;
        },
      },
    });
    mock.module(mod("lib/amux/workerRegistryStore.ts"), {
      namedExports: {
        AmuxWorkerRegistryWriteError: FakeWriteError,
        recordAmuxWorkerRegistryChangeByOwner: async (tx: unknown, input: Record<string, unknown>) => {
          assert.deepEqual(tx, { fake: "tx" });
          const { workerName, roleCeiling, desiredState, expectedRevision } = input;
          world.changes.push({ workerName, roleCeiling, desiredState, expectedRevision });
          if (world.storeError) throw world.storeError;
          return {
            eventId: "event-1",
            auditLogId: "audit-1",
            action: "amux.worker.register",
            workerName,
            revision: 1,
            sequence: "7",
            createdAt: "2026-10-12T00:00:00.000Z",
          };
        },
      },
    });
  }
  return import(mod("app/api/admin/amux/workers/route.ts"));
}

const URL_ = "https://tomverse.app/api/admin/amux/workers";
const get = () => new Request(URL_);
const post = (body: unknown) =>
  new Request(URL_, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const stale = () => ({
  session: { user: { id: "owner-1", authenticatedAt: new Date(Date.now() - 6 * 60 * 60_000).toISOString() } },
});

const VALID = { workerName: "cursor-impl", roleCeiling: "implementation", desiredState: "requested", expectedRevision: 0 };

test("any administrator reads the registry; nobody else learns it exists", async () => {
  const { GET } = await loadRoute();

  reset({ session: null });
  assert.equal((await GET(get())).status, 404);
  reset({ admin: false });
  assert.equal((await GET(get())).status, 404);
  assert.equal(world.reads, 0);

  // No owner role, no latch and no step-up are needed to read.
  reset({ role: "readonly", latch: false, ...stale() });
  const read = await GET(get());
  assert.equal(read.status, 200);
  assert.deepEqual(await read.json(), VIEW);
  assert.equal(read.headers.get("cache-control"), "private, no-store, max-age=0");

  reset({ readError: new FakeBoundaryError("AMUX_DB_READ_BUSY") });
  const busy = await GET(get());
  assert.equal(busy.status, 503);
  assert.deepEqual(await busy.json(), { error: "registry_unavailable" });
});

test("only the owner reaches a change; with the code latch off nothing does, before any step-up or body", async () => {
  const { POST } = await loadRoute();

  reset({ session: null });
  assert.equal((await POST(post(VALID))).status, 404);
  reset({ admin: false });
  assert.equal((await POST(post(VALID))).status, 404);
  for (const role of ["ops", "billing", "support", "readonly", null]) {
    reset({ role });
    assert.equal((await POST(post(VALID))).status, 403, String(role));
  }

  // R1 ships with the latch off: 409, even with a stale step-up and a bad body.
  reset({ latch: false, ...stale() });
  const off = await POST(post({ anything: true }));
  assert.equal(off.status, 409);
  assert.deepEqual(await off.json(), { error: "registry_writes_off" });
  assert.deepEqual(world.boundaries, []);
  assert.deepEqual(world.changes, []);

  // With the latch on, a stale step-up is 428 with the way back, before the body.
  reset(stale());
  const staleAnswer = await POST(post({ workerName: "x", extra: 1 }));
  assert.equal(staleAnswer.status, 428);
  assert.equal((await staleAnswer.json()).code, "ADMIN_REAUTHENTICATION_REQUIRED");
  assert.deepEqual(world.changes, []);

  reset();
  const changed = await POST(post(VALID));
  assert.equal(changed.status, 200);
  assert.deepEqual(await changed.json(), {
    workerName: "cursor-impl",
    revision: 1,
    action: "amux.worker.register",
    eventId: "event-1",
    sequence: "7",
    createdAt: "2026-10-12T00:00:00.000Z",
  });
  assert.deepEqual(world.boundaries, ["worker_registry_change"]);
  assert.deepEqual(world.changes, [VALID]);
});

test("a body outside the strict shape never reaches the store; the change rule's refusals are 409 with their code", async () => {
  const { POST } = await loadRoute();

  for (const body of [
    { ...VALID, note: "because" },
    { workerName: "cursor-impl" },
    { ...VALID, expectedRevision: "0" },
    { ...VALID, expectedRevision: -1 },
    { ...VALID, workerName: "x".repeat(41) },
    "not json",
  ]) {
    reset();
    const answer = await POST(post(body));
    assert.equal(answer.status, 400, JSON.stringify(body));
    assert.deepEqual(world.boundaries, [], JSON.stringify(body));
  }

  reset({ storeError: new FakeWriteError("invalid_change") });
  const invalid = await POST(post(VALID));
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), { error: "invalid_change" });

  for (const code of ["activation_requires_trial", "stale_revision", "retired", "role_above_class", "no_change"]) {
    reset({ storeError: new FakeWriteError(code) });
    const refused = await POST(post(VALID));
    assert.equal(refused.status, 409, code);
    assert.deepEqual(await refused.json(), { error: code });
  }

  reset({ storeError: new FakeWriteError("no_operator") });
  assert.equal((await POST(post(VALID))).status, 404);
});

test("an unknown outcome says so, and every other failure says it was not recorded", async () => {
  const { POST } = await loadRoute();

  reset({ boundaryError: new FakeBoundaryError("AMUX_DB_OUTCOME_UNKNOWN") });
  const unknown = await POST(post(VALID));
  assert.equal(unknown.status, 503);
  assert.deepEqual(await unknown.json(), { error: "outcome_unknown" });

  for (const code of ["AMUX_DB_DEADLINE_EXCEEDED", "AMUX_DB_NOT_STARTED", "AMUX_DB_PRISMA_CALL_CEILING_EXCEEDED"]) {
    reset({ boundaryError: new FakeBoundaryError(code) });
    const failed = await POST(post(VALID));
    assert.equal(failed.status, 503, code);
    assert.deepEqual(await failed.json(), { error: "registry_change_failed" }, code);
  }

  reset({ storeError: new Error("guard refused the event") });
  const guard = await POST(post(VALID));
  assert.equal(guard.status, 503);
  assert.deepEqual(await guard.json(), { error: "registry_change_failed" });
});
