import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mock, test } from "node:test";

// AMUX Decision Maker policy version 1, section 8: the switch route. Reading
// is open to any administrator; a change needs `ops:write` and a recent
// step-up, both checked before the body is read, and a stale step-up is 428
// with the reauthentication code a panel turns into the way back. The store
// and the DB boundary are faked; the boundary around the real store is the
// agents lane's (tests/integration/amux-decision-maker-switch.db.test.ts).

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
  opsWrite: boolean;
  boundaries: string[];
  changes: Array<{ scope: unknown; value: unknown }>;
  boundaryError: Error | null;
  storeError: Error | null;
  budgetDepth: number;
  sessionReadsInBudget: boolean[];
};
let world: World;
const reset = (changes: Partial<World> = {}) => {
  world = {
    session: { user: { id: "operator-1", authenticatedAt: new Date().toISOString() } },
    admin: true,
    opsWrite: true,
    boundaries: [],
    changes: [],
    boundaryError: null,
    storeError: null,
    budgetDepth: 0,
    sessionReadsInBudget: [],
    ...changes,
  };
};
reset();

const STATE = {
  killSwitch: false,
  instances: { "decision-maker-openai": "proposal", "decision-maker-anthropic": "off" },
};

type Route = {
  GET: (request: Request) => Promise<Response>;
  POST: (request: Request) => Promise<Response>;
};

let installed = false;
async function loadRoute(): Promise<Route> {
  if (!installed) {
    installed = true;
    mock.module("next-auth/next", {
      namedExports: {
        getServerSession: async () => {
          // The budget starts before the first await of either handler.
          world.sessionReadsInBudget.push(world.budgetDepth === 1);
          return world.session;
        },
      },
    });
    mock.module(mod("lib/auth.ts"), { namedExports: { authOptions: {} } });
    mock.module(mod("lib/adminAuth.ts"), {
      namedExports: {
        isAdminSession: () => world.admin,
        hasAdminPermission: (_session: unknown, permission: string) =>
          permission === "ops:write" && world.opsWrite,
      },
    });
    const realApiSecurity = require(resolve(ROOT, "lib/apiSecurity.ts"));
    mock.module(mod("lib/apiSecurity.ts"), {
      namedExports: { ...realApiSecurity, consumeApiRateLimit: async () => {} },
    });
    mock.module(mod("lib/amux/dbBoundary.ts"), {
      namedExports: {
        AMUX_DB_BOUNDARIES: {
          decisionMakerSwitchRead: { operation: "decision_maker_switch_read" },
          decisionMakerSwitchChange: { operation: "decision_maker_switch_change" },
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
    mock.module(mod("lib/amux/decisionMakerSwitchStore.ts"), {
      namedExports: {
        DecisionMakerSwitchWriteError: FakeWriteError,
        readDecisionMakerSwitchesOrThrow: async (tx: unknown) => {
          assert.deepEqual(tx, { fake: "tx" });
          if (world.storeError) throw world.storeError;
          return STATE;
        },
        recordDecisionMakerSwitchByOperator: async (
          tx: unknown,
          input: { scope: unknown; value: unknown },
        ) => {
          assert.deepEqual(tx, { fake: "tx" });
          world.changes.push({ scope: input.scope, value: input.value });
          if (world.storeError) throw world.storeError;
          return {
            eventId: "event-1",
            auditLogId: "audit-1",
            sequence: "7",
            createdAt: "2026-10-09T00:00:00.000Z",
            action: "amux.decision.mode",
          };
        },
      },
    });
  }
  return import(mod("app/api/admin/amux/decision-maker/switches/route.ts"));
}

const URL_ = "https://tomverse.app/api/admin/amux/decision-maker/switches";
const get = () => new Request(URL_);
const post = (body: unknown) =>
  new Request(URL_, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const stale = () => ({
  session: {
    user: { id: "operator-1", authenticatedAt: new Date(Date.now() - 6 * 60 * 60_000).toISOString() },
  },
});

test("any administrator reads the switches through the read boundary; nobody else learns they exist", async () => {
  const { GET } = await loadRoute();

  reset({ session: null });
  assert.equal((await GET(get())).status, 404);
  reset({ admin: false });
  assert.equal((await GET(get())).status, 404);
  assert.deepEqual(world.boundaries, []);

  // No write permission and no step-up are needed to read.
  reset({ opsWrite: false, ...stale() });
  const read = await GET(get());
  assert.equal(read.status, 200);
  assert.deepEqual(await read.json(), STATE);
  assert.equal(read.headers.get("cache-control"), "private, no-store, max-age=0");
  assert.deepEqual(world.boundaries, ["decision_maker_switch_read"]);
  assert.deepEqual(world.sessionReadsInBudget, [true]);

  reset({ boundaryError: new FakeBoundaryError("AMUX_DB_READ_BUSY") });
  const busy = await GET(get());
  assert.equal(busy.status, 503);
  assert.deepEqual(await busy.json(), { error: "switch_state_unavailable" });
});

test("only ops:write with a recent step-up reaches a change, before the body is read", async () => {
  const { POST } = await loadRoute();
  const valid = { scope: "decision-maker-openai", value: "proposal" };

  reset({ session: null });
  assert.equal((await POST(post(valid))).status, 404);
  reset({ admin: false });
  assert.equal((await POST(post(valid))).status, 404);
  reset({ opsWrite: false });
  assert.equal((await POST(post(valid))).status, 403);
  assert.deepEqual(world.changes, []);

  // A stale step-up is 428 with the code a panel turns into the way back, even
  // for a body that would be refused.
  reset(stale());
  const staleAnswer = await POST(post({ scope: "x", value: "autonomous", extra: 1 }));
  assert.equal(staleAnswer.status, 428);
  assert.equal((await staleAnswer.json()).code, "ADMIN_REAUTHENTICATION_REQUIRED");
  assert.equal(staleAnswer.headers.get("cache-control"), "private, no-store, max-age=0");
  assert.deepEqual(world.boundaries, []);
  assert.deepEqual(world.changes, []);

  reset();
  const changed = await POST(post(valid));
  assert.equal(changed.status, 200);
  assert.deepEqual(await changed.json(), {
    scope: "decision-maker-openai",
    value: "proposal",
    action: "amux.decision.mode",
    eventId: "event-1",
    sequence: "7",
    createdAt: "2026-10-09T00:00:00.000Z",
  });
  assert.deepEqual(world.boundaries, ["decision_maker_switch_change"]);
  assert.deepEqual(world.changes, [valid]);
  assert.deepEqual(world.sessionReadsInBudget, [true]);
});

test("a body outside the strict shape never reaches the store, and the store's refusal is 400", async () => {
  const { POST } = await loadRoute();

  for (const body of [
    { scope: "kill_switch", value: "on", reason: "because" },
    { scope: "kill_switch" },
    { scope: 1, value: "on" },
    { scope: "kill_switch", value: "x".repeat(17) },
    "not json",
  ]) {
    reset();
    const answer = await POST(post(body));
    assert.equal(answer.status, 400, JSON.stringify(body));
    assert.deepEqual(world.boundaries, [], JSON.stringify(body));
  }

  // The vocabulary is the store's: a well-formed body with a value it does not
  // accept is its `invalid_change`, and nothing is written.
  reset({ storeError: new FakeWriteError("invalid_change") });
  const refused = await POST(post({ scope: "decision-maker-openai", value: "autonomous" }));
  assert.equal(refused.status, 400);
  assert.deepEqual(await refused.json(), { error: "invalid_change" });
});

test("an unknown outcome says so, and every other failure says it was not recorded", async () => {
  const { POST } = await loadRoute();
  const valid = { scope: "kill_switch", value: "on" };

  reset({ boundaryError: new FakeBoundaryError("AMUX_DB_OUTCOME_UNKNOWN") });
  const unknown = await POST(post(valid));
  assert.equal(unknown.status, 503);
  assert.deepEqual(await unknown.json(), { error: "outcome_unknown" });

  for (const code of ["AMUX_DB_DEADLINE_EXCEEDED", "AMUX_DB_NOT_STARTED", "AMUX_DB_PRISMA_CALL_CEILING_EXCEEDED"]) {
    reset({ boundaryError: new FakeBoundaryError(code) });
    const failed = await POST(post(valid));
    assert.equal(failed.status, 503, code);
    assert.deepEqual(await failed.json(), { error: "switch_change_failed" }, code);
  }

  reset({ storeError: new Error("guard refused the event") });
  const guard = await POST(post(valid));
  assert.equal(guard.status, 503);
  assert.deepEqual(await guard.json(), { error: "switch_change_failed" });
});
