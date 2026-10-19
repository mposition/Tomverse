import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mock, test } from "node:test";

// docs/policy/amux-decision-maker.md §2-7, §9: a person resolves an unknown delivery as
// delivered or not delivered. `ops:write` and a recent step-up before the body
// is read; the store's refusal is 409 with its reason; an unknown outcome says
// so. The store and the DB boundary are faked; the boundary around the real
// store is the agents lane's (tests/integration/amux-decision-maker-judgment.db.test.ts).

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

type Resolution = { requestId: unknown; outcome: unknown };
type World = {
  session: { user: { id: string; authenticatedAt?: string } } | null;
  admin: boolean;
  opsWrite: boolean;
  boundaries: string[];
  resolutions: Resolution[];
  boundaryError: Error | null;
  storeError: Error | null;
  storeAnswer: unknown;
  budgetDepth: number;
};
let world: World;
const RECORDED = {
  recorded: true,
  outcome: "delivered",
  event: { eventId: "e-1", auditLogId: "audit-1", sequence: "4", createdAt: "2026-10-19T12:00:00.000Z" },
};
const reset = (changes: Partial<World> = {}) => {
  world = {
    session: { user: { id: "operator-1", authenticatedAt: new Date().toISOString() } },
    admin: true,
    opsWrite: true,
    boundaries: [],
    resolutions: [],
    boundaryError: null,
    storeError: null,
    storeAnswer: RECORDED,
    budgetDepth: 0,
    ...changes,
  };
};
reset();

type Route = { POST: (request: Request) => Promise<Response> };

let installed = false;
async function loadRoute(): Promise<Route> {
  if (!installed) {
    installed = true;
    mock.module("next-auth/next", { namedExports: { getServerSession: async () => world.session } });
    mock.module(mod("lib/auth.ts"), { namedExports: { authOptions: {} } });
    mock.module(mod("lib/adminAuth.ts"), {
      namedExports: {
        isAdminSession: () => world.admin,
        hasAdminPermission: (_session: unknown, permission: string) => permission === "ops:write" && world.opsWrite,
      },
    });
    const realApiSecurity = require(resolve(ROOT, "lib/apiSecurity.ts"));
    mock.module(mod("lib/apiSecurity.ts"), {
      namedExports: { ...realApiSecurity, consumeApiRateLimit: async () => {} },
    });
    mock.module(mod("lib/amux/dbBoundary.ts"), {
      namedExports: {
        AMUX_DB_BOUNDARIES: { decisionMakerDeliveryResolve: { operation: "decision_maker_delivery_resolve" } },
        AmuxDbBoundaryError: FakeBoundaryError,
        withAmuxRouteBudget: async (work: () => Promise<unknown>) => {
          world.budgetDepth += 1;
          try {
            return await work();
          } finally {
            world.budgetDepth -= 1;
          }
        },
        withAmuxDbBoundary: async (boundary: { operation: string }, work: (tx: unknown) => Promise<unknown>) => {
          assert.equal(world.budgetDepth, 1, "a boundary runs only inside the route budget");
          world.boundaries.push(boundary.operation);
          if (world.boundaryError) throw world.boundaryError;
          return work({ fake: "tx" });
        },
      },
    });
    mock.module(mod("lib/amux/decisionMakerJudgmentStore.ts"), {
      namedExports: {
        DecisionMakerJudgmentWriteError: FakeWriteError,
        resolveDecisionMakerDeliveryUnknown: async (tx: unknown, input: Resolution & { session: unknown; request: unknown }) => {
          assert.deepEqual(tx, { fake: "tx" });
          assert.ok(input.session, "the session is the store's to check");
          assert.ok(input.request instanceof Request, "the request goes to the person's audit");
          world.resolutions.push({ requestId: input.requestId, outcome: input.outcome });
          if (world.storeError) throw world.storeError;
          return world.storeAnswer;
        },
      },
    });
  }
  return import(mod("app/api/admin/amux/decision-maker/deliveries/resolve/route.ts"));
}

const post = (body: unknown) =>
  new Request("https://tomverse.app/api/admin/amux/decision-maker/deliveries/resolve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const REQUEST_ID = "00000000-0000-4000-8000-000000000011";
const BODY = { requestId: REQUEST_ID, outcome: "delivered" };

test("only ops:write with a recent step-up resolves a delivery, before the body is read", async () => {
  const { POST } = await loadRoute();
  reset({ session: null });
  assert.equal((await POST(post(BODY))).status, 404);
  reset({ admin: false });
  assert.equal((await POST(post(BODY))).status, 404);
  reset({ opsWrite: false });
  assert.equal((await POST(post(BODY))).status, 403);
  reset({ session: { user: { id: "operator-1", authenticatedAt: new Date(Date.now() - 6 * 60 * 60_000).toISOString() } } });
  const stale = await POST(post({ nonsense: true }));
  assert.equal(stale.status, 428);
  assert.equal((await stale.json()).code, "ADMIN_REAUTHENTICATION_REQUIRED");
  assert.deepEqual(world.boundaries, []);
  assert.deepEqual(world.resolutions, []);

  reset();
  const recorded = await POST(post(BODY));
  assert.equal(recorded.status, 200);
  assert.deepEqual(await recorded.json(), { recorded: true, outcome: "delivered", createdAt: RECORDED.event.createdAt });
  assert.equal(recorded.headers.get("cache-control"), "private, no-store, max-age=0");
  assert.deepEqual(world.boundaries, ["decision_maker_delivery_resolve"]);
  assert.deepEqual(world.resolutions, [BODY]);
});

test("a body outside the strict shape never reaches the store; the store's invalid input is 400", async () => {
  const { POST } = await loadRoute();
  for (const body of [{ ...BODY, extra: 1 }, { outcome: "delivered" }, { requestId: 1, outcome: "delivered" }, "not json"]) {
    reset();
    assert.equal((await POST(post(body))).status, 400);
    assert.deepEqual(world.boundaries, []);
  }
  reset({ storeError: new FakeWriteError("invalid_input") });
  const invalid = await POST(post({ requestId: REQUEST_ID, outcome: "maybe" }));
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), { error: "invalid_resolution" });
  reset({ storeError: new FakeWriteError("no_operator") });
  assert.equal((await POST(post(BODY))).status, 404);
});

test("the store's refusal is 409 with its reason, and an unknown outcome is said, not retried", async () => {
  const { POST } = await loadRoute();
  for (const reason of ["not_unknown", "already_resolved", "not_confirmed"]) {
    reset({ storeAnswer: { recorded: false, reason } });
    const refused = await POST(post(BODY));
    assert.equal(refused.status, 409);
    assert.deepEqual(await refused.json(), { error: "resolution_refused", reason });
  }
  reset({ boundaryError: new FakeBoundaryError("AMUX_DB_OUTCOME_UNKNOWN") });
  const unknown = await POST(post(BODY));
  assert.equal(unknown.status, 503);
  assert.deepEqual(await unknown.json(), { error: "outcome_unknown" });
  assert.equal(world.boundaries.length, 1, "one transaction, never a retry");
  reset({ boundaryError: new FakeBoundaryError("AMUX_DB_DEADLINE_EXCEEDED") });
  assert.deepEqual(await (await POST(post(BODY))).json(), { error: "resolution_failed" });
});
