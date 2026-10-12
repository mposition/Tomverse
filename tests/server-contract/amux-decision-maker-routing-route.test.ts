import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mock, test } from "node:test";

// AMUX Decision Maker policy version 1, sections 2-1 and 3: the routing route
// the bridge calls. Only the sync token reaches it; it stays closed until the
// operator enables it; a body outside its strict shape never reaches the
// store; the store's refusals each have their own answer; the transaction runs
// in the routing boundary inside the route budget; and no answer or log line
// carries the card. The store is faked; its transaction is the agents lane's
// (tests/integration/amux-decision-maker-body.db.test.ts).

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relative: string) => pathToFileURL(resolve(ROOT, relative)).href;
const require = createRequire(import.meta.url);

class FakeRequestWriteError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
class FakeBodyWriteError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
class FakeDigestKeyError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

const RING = new Map([[20000, Buffer.alloc(32, 7)]]);

type World = {
  authorized: boolean;
  env: string | undefined;
  budgetDepth: number;
  boundaries: Array<{ operation: string; inBudget: boolean }>;
  calls: Array<{ binding: unknown; card: unknown; keyRing: unknown }>;
  keyRingError: Error | null;
  storeError: Error | null;
  internalErrors: Array<{ operation: string; error: unknown }>;
  logged: string[];
};
let world: World;
const reset = (changes: Partial<World> = {}) => {
  world = {
    authorized: true,
    env: "enabled",
    budgetDepth: 0,
    boundaries: [],
    calls: [],
    keyRingError: null,
    storeError: null,
    internalErrors: [],
    logged: [],
    ...changes,
  };
  if (world.env === undefined) delete process.env.TOMVERSE_AMUX_DM_ROUTING;
  else process.env.TOMVERSE_AMUX_DM_ROUTING = world.env;
};
reset();

const ROUTED = {
  requestId: "11111111-2222-4333-8444-555555555555",
  created: true,
  route: "dm_proposal",
  instance: "decision-maker-openai",
  refusalCodes: [],
  sameBinding: true,
  createdAt: "2026-10-10T00:00:00.000Z",
  assignmentDeadlineAt: "2026-10-10T00:02:00.000Z",
  routeAuditLogId: "audit-1",
  cardText: { digest: "d".repeat(64), keyPeriod: 20000, bytes: 321 },
};

let installed = false;
async function loadRoute(): Promise<{ POST: (request: Request) => Promise<Response> }> {
  if (!installed) {
    installed = true;
    mock.module(mod("lib/amux/guard.ts"), {
      namedExports: { isAmuxSyncAuthorized: () => world.authorized },
    });
    mock.module(mod("lib/amux/dbBoundary.ts"), {
      namedExports: {
        AMUX_DB_BOUNDARIES: { decisionMakerRouting: { operation: "decision_maker_routing" } },
        withAmuxRouteBudget: async (work: () => Promise<unknown>) => {
          world.budgetDepth += 1;
          try {
            return await work();
          } finally {
            world.budgetDepth -= 1;
          }
        },
        withAmuxDbBoundary: async (boundary: { operation: string }, work: (tx: unknown) => Promise<unknown>) => {
          world.boundaries.push({ operation: boundary.operation, inBudget: world.budgetDepth === 1 });
          return work({ fake: "tx" });
        },
      },
    });
    mock.module(mod("lib/amux/decisionMakerBodyStore.ts"), {
      namedExports: {
        DecisionMakerBodyWriteError: FakeBodyWriteError,
        recordDecisionMakerRequestWithCardText: async (
          tx: unknown,
          input: { binding: unknown; card: unknown; keyRing: unknown },
        ) => {
          assert.deepEqual(tx, { fake: "tx" });
          world.calls.push(input);
          if (world.storeError) throw world.storeError;
          return ROUTED;
        },
      },
    });
    mock.module(mod("lib/amux/decisionMakerRequestStore.ts"), {
      namedExports: { DecisionMakerRequestWriteError: FakeRequestWriteError },
    });
    mock.module(mod("lib/amux/decisionMakerDigestKeys.ts"), {
      namedExports: {
        DecisionMakerDigestKeyError: FakeDigestKeyError,
        loadDecisionMakerDigestKeyRing: () => {
          if (world.keyRingError) throw world.keyRingError;
          return RING;
        },
      },
    });
    const realInternal = require(resolve(ROOT, "lib/amux/internalRoute.ts"));
    mock.module(mod("lib/amux/internalRoute.ts"), {
      namedExports: {
        ...realInternal,
        amuxInternalErrorResponse: (operation: string, error: unknown) => {
          world.internalErrors.push({ operation, error });
          return realInternal.amuxJsonNoStore({ error: "internal" }, 500);
        },
      },
    });
    mock.method(console, "error", (line: unknown) => {
      world.logged.push(String(line));
    });
  }
  return import(mod("app/api/internal/amux/decision-maker/requests/route.ts"));
}

const BINDING = {
  cardId: "card-1",
  questionRevision: 1,
  askingWorkerId: "worker.claude-1",
  amuxSessionId: "session:7",
  amuxSessionAttempt: 1,
  askingProvider: "claude",
  termListVersion: "v1",
  classificationVersion: "authority-manifest-1",
  scannerVersion: "v1",
};
const CARD = {
  askType: "decision",
  resolution: null,
  type: "task",
  tags: ["needs:you"],
  title: "Pick a cache key layout",
  question: "Should the cache key include the locale?",
  options: [{ id: "a", label: "Model id only" }],
  unblocks: "The cache module can be finished.",
  context: "Both layouts pass.",
  contextPaths: ["lib/cache.ts"],
};

const post = (body: unknown) =>
  new Request("https://tomverse.app/api/internal/amux/decision-maker/requests", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

test("only the sync token reaches the route, and it stays closed until the operator enables it", async () => {
  const { POST } = await loadRoute();

  reset({ authorized: false });
  const unauthorized = await POST(post({ binding: BINDING, card: CARD }));
  assert.equal(unauthorized.status, 401);
  assert.equal(world.calls.length, 0);

  for (const env of [undefined, "", "true", "ENABLED", "enabled "]) {
    reset({ env });
    const closed = await POST(post({ binding: BINDING, card: CARD }));
    assert.equal(closed.status, 409, String(env));
    assert.deepEqual(await closed.json(), { routed: false, reason: "dm_routing_disabled" });
    assert.equal(closed.headers.get("cache-control"), "no-store");
    assert.deepEqual(world.boundaries, []);
    assert.equal(world.calls.length, 0);
  }
});

test("an enabled route records through the routing boundary inside the route budget and answers without the card", async () => {
  const { POST } = await loadRoute();
  reset();
  const answer = await POST(post({ binding: BINDING, card: CARD }));
  assert.equal(answer.status, 200);
  const body = await answer.json();
  assert.deepEqual(body, {
    routed: true,
    request_id: ROUTED.requestId,
    created: true,
    route: "dm_proposal",
    instance: "decision-maker-openai",
    refusal_codes: [],
    same_binding: true,
    created_at: ROUTED.createdAt,
    assignment_deadline_at: ROUTED.assignmentDeadlineAt,
    card_text_stored: true,
  });
  // No card wording, digest, key period or audit id leaves the route.
  assert.doesNotMatch(JSON.stringify(body), /cache key|Model id only|audit-1|d{64}/);
  assert.deepEqual(world.boundaries, [{ operation: "decision_maker_routing", inBudget: true }]);
  assert.deepEqual(world.calls, [{ binding: BINDING, card: CARD, keyRing: RING }]);
});

test("a body outside the strict shape never reaches the store", async () => {
  const { POST } = await loadRoute();
  for (const body of [
    { binding: BINDING, card: CARD, route: "dm_proposal" },
    { binding: BINDING, card: CARD, keyRing: "0:abc" },
    "not json",
    JSON.stringify({ binding: BINDING, card: { ...CARD, context: "x".repeat(70 * 1_024) } }),
  ]) {
    reset();
    const answer = await POST(post(body));
    assert.ok(answer.status === 400 || answer.status === 413, String(answer.status));
    assert.equal(world.calls.length, 0);
    assert.deepEqual(world.boundaries, []);
  }
});

test("a missing or malformed key ring refuses before the database, and logs its code only", async () => {
  const { POST } = await loadRoute();
  for (const code of ["not_configured", "malformed"]) {
    reset({ keyRingError: new FakeDigestKeyError(code) });
    process.env.AMUX_DM_DIGEST_KEYS = "0:c2VjcmV0LXZhbHVlLXRoYXQtbXVzdC1uZXZlci1sb2c=";
    const answer = await POST(post({ binding: BINDING, card: CARD }));
    assert.equal(answer.status, 503);
    assert.deepEqual(await answer.json(), { routed: false, reason: "dm_digest_keys_unavailable" });
    assert.deepEqual(world.boundaries, []);
    assert.equal(world.calls.length, 0);
    assert.equal(world.logged.length, 1);
    assert.deepEqual(JSON.parse(world.logged[0]!), {
      subsystem: "amux",
      event: "dm_digest_keys_unavailable",
      code,
    });
    assert.doesNotMatch(world.logged.join("\n"), /c2VjcmV0/);
    delete process.env.AMUX_DM_DIGEST_KEYS;
  }
});

test("each refusal of the store has its own answer, and nothing else is guessed", async () => {
  const { POST } = await loadRoute();
  for (const [error, status, reason] of [
    [new FakeRequestWriteError("invalid_input"), 400, "invalid_input"],
    [new FakeRequestWriteError("key_period_changed"), 409, "dm_key_period_changed"],
    [new FakeRequestWriteError("digest_key_unavailable"), 503, "dm_digest_key_unavailable"],
    [new FakeRequestWriteError("settings_unreadable"), 503, "dm_settings_unreadable"],
    [new FakeRequestWriteError("state_unreadable"), 503, "dm_state_unreadable"],
    [new FakeBodyWriteError("digest_key_unavailable"), 503, "dm_digest_key_unavailable"],
  ] as const) {
    reset({ storeError: error });
    const answer = await POST(post({ binding: BINDING, card: CARD }));
    assert.equal(answer.status, status, reason);
    assert.deepEqual(await answer.json(), { routed: false, reason }, reason);
    assert.deepEqual(world.internalErrors, []);
  }

  // Anything else -- a boundary deadline, an unknown outcome, a database
  // error -- is the shared AMUX internal answer, named for this operation.
  const other = new Error("boundary failure");
  reset({ storeError: other });
  const answer = await POST(post({ binding: BINDING, card: CARD }));
  assert.equal(answer.status, 500);
  assert.equal(world.internalErrors.length, 1);
  assert.equal(world.internalErrors[0]!.operation, "decision_maker_routing");
  assert.equal(world.internalErrors[0]!.error, other);
});
