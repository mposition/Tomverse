import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mock, test } from "node:test";

// AMUX Decision Maker policy version 1 (docs/policy/amux-decision-maker.md),
// sections 2, 5, 8, 9 and 10: the internal
// routes the bridge and the broker call after the routing -- assignment,
// assignment discard, transmission intent, transmission outcome, result
// submission, result lookup, result unknown and (since 2026-10-17) cleanup
// unknown, and the validation latch check the result route runs after a
// validation failure. Only the sync token reaches
// them; each stays closed until the operator enables it and then touches
// nothing; a body outside its strict shape or size never reaches the store;
// each runs its one store operation in its own DB boundary inside the route
// budget; what the store returns or throws each has its own answer; and no
// answer or log line carries a card, a DM output, a body or the period key.
// The stores are faked; their transactions are the agents lane's
// (tests/integration/amux-decision-maker-body.db.test.ts and
// tests/integration/amux-decision-maker-request.db.test.ts), and their
// statements are counted in tests/amuxDecisionMakerBody.test.mjs and
// tests/amuxDecisionMakerRequest.test.mjs.

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

const PERIOD_KEY = Buffer.alloc(32, 7);
const RING = new Map([[20000, PERIOD_KEY]]);
const REQUEST_KEY = Buffer.alloc(32, 3);
const REQUEST_ID = "11111111-2222-4333-8444-555555555555";
const DIGEST_B = "b".repeat(64);
const DIGEST_C = "c".repeat(64);
const SHA = "d".repeat(40);
const EVENT = {
  eventId: "22222222-3333-4444-8555-666666666666",
  auditLogId: "audit-row-1",
  sequence: "7",
  createdAt: "2026-10-16T00:00:00.000Z",
  resultDeadlineAt: null,
};
const ASSIGN_EVENT = { ...EVENT, resultDeadlineAt: "2026-10-16T00:30:00.000Z" };
const LATCH_EVENT = {
  eventId: "33333333-4444-4555-8666-777777777777",
  auditLogId: "audit-row-2",
  sequence: "11",
  createdAt: "2026-10-17T00:00:00.000Z",
};
const OPTIONS = [
  { id: "a", label: "Model id only" },
  { id: "b", label: "Model id and locale" },
];
const RAW = JSON.stringify({
  kind: "free_text",
  answer: "Use the model id only.",
  rationale: "The locale is already in the path.",
  irreversible: false,
});
const TRANSMISSION = {
  snapshotState: "worker_head",
  snapshotTargetSha: SHA,
  snapshotManifestDigest: DIGEST_C,
  inputPayloadDigest: DIGEST_B,
};
const RESULT_BINDING = {
  cardId: "card-1",
  questionRevision: 1,
  askingWorkerId: "worker.claude-1",
  amuxSessionId: "session:7",
  amuxSessionAttempt: 1,
  optionSetDigest: DIGEST_C,
  termListVersion: "v1",
  classificationVersion: "authority-manifest-1",
  scannerVersion: "v1",
  policyVersion: 1,
  transmission: TRANSMISSION,
};

type World = {
  authorized: boolean;
  env: string | undefined;
  budgetDepth: number;
  boundaries: Array<{ operation: string; inBudget: boolean }>;
  calls: Array<{ store: string; input: Record<string, unknown> }>;
  keyRingLoads: number;
  keyRingError: Error | null;
  storeResult: unknown;
  storeError: Error | null;
  /** §8's latch check, which the result route runs after a validation failure. */
  latchResult: unknown;
  latchError: Error | null;
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
    keyRingLoads: 0,
    keyRingError: null,
    storeResult: undefined,
    storeError: null,
    latchResult: { latched: false, reason: "no_streak" },
    latchError: null,
    internalErrors: [],
    logged: [],
    ...changes,
  };
  if (world.env === undefined) delete process.env.TOMVERSE_AMUX_DM_ROUTING;
  else process.env.TOMVERSE_AMUX_DM_ROUTING = world.env;
};
reset();

/** The context's lease callback, which a deadline write must pass on unchanged. */
const LEASE = (deadline: Date) => {
  void deadline;
};
const FAKE_TX = { fake: "tx" };

type Route = {
  name: string;
  path: string;
  url: string;
  boundary: string;
  operation: string;
  store: string;
  envelope: "recorded" | "submitted" | "found";
  maxBodyBytes: number;
  body: Record<string, unknown>;
  /** What the store receives, given the body. */
  input: Record<string, unknown>;
  keyRing: boolean;
  success: unknown;
  answer: Record<string, unknown>;
  /** Refusals the store returns: what it returned, the status, the reason. */
  refusals: Array<[unknown, number, string]>;
};

const ROUTES: Route[] = [
  {
    name: "assignment",
    path: "app/api/internal/amux/decision-maker/assignments/route.ts",
    url: "/api/internal/amux/decision-maker/assignments",
    boundary: "decisionMakerAssignment",
    operation: "decision_maker_assignment",
    store: "assignDecisionMakerRequestWithDigestKey",
    envelope: "recorded",
    maxBodyBytes: 1_024,
    body: { request_id: REQUEST_ID },
    input: { requestId: REQUEST_ID, requireLeaseAt: LEASE, keyRing: RING },
    keyRing: true,
    success: { recorded: true, event: ASSIGN_EVENT, keyPeriod: 20000, requestKey: REQUEST_KEY },
    answer: {
      recorded: true,
      event_id: EVENT.eventId,
      created_at: EVENT.createdAt,
      result_deadline_at: ASSIGN_EVENT.resultDeadlineAt,
      key_period: 20000,
      request_key: REQUEST_KEY.toString("base64"),
    },
    refusals: [
      [{ recorded: false, reason: "unknown_request" }, 404, "unknown_request"],
      [{ recorded: false, reason: "already_assigned" }, 409, "already_assigned"],
      [{ recorded: false, reason: "deadline_passed" }, 409, "deadline_passed"],
      [{ recorded: false, reason: "not_routed_to_dm" }, 409, "not_routed_to_dm"],
      [{ recorded: false, reason: "closed" }, 409, "closed"],
      [{ recorded: false, reason: "digest_key_unavailable" }, 503, "digest_key_unavailable"],
    ],
  },
  {
    name: "assignment discard",
    path: "app/api/internal/amux/decision-maker/assignments/discard/route.ts",
    url: "/api/internal/amux/decision-maker/assignments/discard",
    boundary: "decisionMakerAssignmentDiscard",
    operation: "decision_maker_assignment_discard",
    store: "discardDecisionMakerAssignment",
    envelope: "recorded",
    maxBodyBytes: 1_024,
    body: { request_id: REQUEST_ID },
    input: { requestId: REQUEST_ID },
    keyRing: false,
    success: { recorded: true, event: EVENT },
    answer: { recorded: true, event_id: EVENT.eventId, created_at: EVENT.createdAt },
    refusals: [
      [{ recorded: false, reason: "unknown_request" }, 404, "unknown_request"],
      [{ recorded: false, reason: "not_assigned" }, 409, "not_assigned"],
      [{ recorded: false, reason: "closed" }, 409, "closed"],
    ],
  },
  {
    name: "transmission intent",
    path: "app/api/internal/amux/decision-maker/transmissions/route.ts",
    url: "/api/internal/amux/decision-maker/transmissions",
    boundary: "decisionMakerTransmitIntent",
    operation: "decision_maker_transmit_intent",
    store: "recordDecisionMakerTransmitIntent",
    envelope: "recorded",
    maxBodyBytes: 2_048,
    body: { request_id: REQUEST_ID, instance: "decision-maker-openai", transmission: TRANSMISSION },
    input: {
      requestId: REQUEST_ID,
      instance: "decision-maker-openai",
      transmission: TRANSMISSION,
      requireLeaseAt: LEASE,
    },
    keyRing: false,
    success: { recorded: true, event: EVENT },
    answer: { recorded: true, event_id: EVENT.eventId, created_at: EVENT.createdAt },
    refusals: [
      [{ recorded: false, reason: "unknown_request" }, 404, "unknown_request"],
      [{ recorded: false, reason: "already_transmitted" }, 409, "already_transmitted"],
      [{ recorded: false, reason: "instance_mismatch" }, 409, "instance_mismatch"],
      [{ recorded: false, reason: "deadline_passed" }, 409, "deadline_passed"],
      [{ recorded: false, reason: "kill_switch_on" }, 409, "kill_switch_on"],
      [{ recorded: false, reason: "instance_off" }, 409, "instance_off"],
      [{ recorded: false, reason: "settings_unreadable" }, 503, "settings_unreadable"],
    ],
  },
  {
    name: "transmission outcome",
    path: "app/api/internal/amux/decision-maker/transmissions/outcome/route.ts",
    url: "/api/internal/amux/decision-maker/transmissions/outcome",
    boundary: "decisionMakerTransmitOutcome",
    operation: "decision_maker_transmit_outcome",
    store: "recordDecisionMakerTransmitOutcome",
    envelope: "recorded",
    maxBodyBytes: 1_024,
    body: { request_id: REQUEST_ID, instance: "decision-maker-openai", outcome: "receipt" },
    input: { requestId: REQUEST_ID, instance: "decision-maker-openai", outcome: "receipt" },
    keyRing: false,
    success: { recorded: true, event: EVENT },
    answer: { recorded: true, event_id: EVENT.eventId, created_at: EVENT.createdAt },
    refusals: [
      [{ recorded: false, reason: "unknown_request" }, 404, "unknown_request"],
      [{ recorded: false, reason: "not_transmitted" }, 409, "not_transmitted"],
      [{ recorded: false, reason: "transmit_outcome_recorded" }, 409, "transmit_outcome_recorded"],
    ],
  },
  {
    name: "result submission",
    path: "app/api/internal/amux/decision-maker/results/route.ts",
    url: "/api/internal/amux/decision-maker/results",
    boundary: "decisionMakerResultSubmission",
    operation: "decision_maker_result_submission",
    store: "submitDecisionMakerOutput",
    envelope: "submitted",
    maxBodyBytes: 256 * 1_024,
    body: {
      request_id: REQUEST_ID,
      instance: "decision-maker-openai",
      binding: RESULT_BINDING,
      output: { kind: "output", raw: RAW, options: OPTIONS },
    },
    input: {
      requestId: REQUEST_ID,
      instance: "decision-maker-openai",
      binding: RESULT_BINDING,
      output: { kind: "output", raw: RAW, options: OPTIONS },
      requireLeaseAt: LEASE,
      keyRing: RING,
    },
    keyRing: true,
    success: {
      status: "submitted",
      resultKind: "proposal",
      validationFailure: null,
      resultDigest: DIGEST_C,
      result: { status: "accepted", event: EVENT, resultKind: "proposal" },
      detail: { outputKind: "free_text", optionId: null, irreversible: false },
      storedFields: ["dm_answer", "dm_rationale"],
    },
    answer: {
      submitted: true,
      status: "accepted",
      result_kind: "proposal",
      validation_failure: null,
      result_digest: DIGEST_C,
      event_id: EVENT.eventId,
      reason: null,
    },
    refusals: [
      [{ status: "unknown_request" }, 404, "unknown_request"],
      [{ status: "digest_key_unavailable" }, 503, "digest_key_unavailable"],
      [{ status: "option_set_mismatch" }, 409, "option_set_mismatch"],
      [
        {
          status: "submitted",
          resultKind: "proposal",
          validationFailure: null,
          resultDigest: DIGEST_C,
          result: { status: "instance_mismatch" },
          detail: null,
          storedFields: [],
        },
        409,
        "instance_mismatch",
      ],
      [
        {
          status: "submitted",
          resultKind: "proposal",
          validationFailure: null,
          resultDigest: DIGEST_C,
          result: { status: "unknown_request" },
          detail: null,
          storedFields: [],
        },
        404,
        "unknown_request",
      ],
    ],
  },
  {
    name: "result lookup",
    path: "app/api/internal/amux/decision-maker/results/lookup/route.ts",
    url: "/api/internal/amux/decision-maker/results/lookup",
    boundary: "decisionMakerResultLookupRead",
    operation: "decision_maker_result_lookup_read",
    store: "lookupDecisionMakerResult",
    envelope: "found",
    maxBodyBytes: 1_024,
    body: { request_id: REQUEST_ID, result_digest: DIGEST_C },
    input: { requestId: REQUEST_ID, resultDigest: DIGEST_C },
    keyRing: false,
    success: { status: "accepted", eventId: EVENT.eventId, resultKind: "proposal" },
    answer: { found: true, status: "accepted", result_kind: "proposal", event_id: EVENT.eventId, reason: null },
    refusals: [[null, 404, "unknown_request"]],
  },
  {
    name: "result unknown",
    path: "app/api/internal/amux/decision-maker/results/unknown/route.ts",
    url: "/api/internal/amux/decision-maker/results/unknown",
    boundary: "decisionMakerResultUnknown",
    operation: "decision_maker_result_unknown",
    store: "recordDecisionMakerResultUnknown",
    envelope: "recorded",
    maxBodyBytes: 1_024,
    body: { request_id: REQUEST_ID, instance: "decision-maker-openai", result_digest: DIGEST_C },
    input: { requestId: REQUEST_ID, instance: "decision-maker-openai", resultDigest: DIGEST_C },
    keyRing: false,
    success: { recorded: true, event: EVENT },
    answer: { recorded: true, event_id: EVENT.eventId, created_at: EVENT.createdAt },
    refusals: [
      [{ recorded: false, reason: "unknown_request" }, 404, "unknown_request"],
      [{ recorded: false, reason: "already_accepted" }, 409, "already_accepted"],
      [{ recorded: false, reason: "already_rejected" }, 409, "already_rejected"],
      [{ recorded: false, reason: "result_recorded" }, 409, "result_recorded"],
      [{ recorded: false, reason: "not_transmitted" }, 409, "not_transmitted"],
    ],
  },
  {
    // §5: a request directory whose deletion the broker could not confirm.
    name: "cleanup unknown",
    path: "app/api/internal/amux/decision-maker/cleanups/unknown/route.ts",
    url: "/api/internal/amux/decision-maker/cleanups/unknown",
    boundary: "decisionMakerCleanupUnknown",
    operation: "decision_maker_cleanup_unknown",
    store: "recordDecisionMakerCleanupUnknown",
    envelope: "recorded",
    maxBodyBytes: 1_024,
    body: { request_id: REQUEST_ID, instance: "decision-maker-openai" },
    input: { requestId: REQUEST_ID, instance: "decision-maker-openai" },
    keyRing: false,
    success: { recorded: true, auditLogId: "audit-row-1", latch: LATCH_EVENT },
    // The latch's switch event; never an audit id.
    answer: { recorded: true, latch_event_id: LATCH_EVENT.eventId, created_at: LATCH_EVENT.createdAt },
    refusals: [
      [{ recorded: false, reason: "unknown_request" }, 404, "unknown_request"],
      [{ recorded: false, reason: "instance_mismatch" }, 409, "instance_mismatch"],
      [{ recorded: false, reason: "not_assigned" }, 409, "not_assigned"],
    ],
  },
];

/** The latch check's own boundary, which no route above names as its own. */
const LATCH_BOUNDARY = { name: "decisionMakerValidationLatch", operation: "decision_maker_validation_latch" };

const fakeLatch = async (tx: unknown, input: Record<string, unknown>) => {
  assert.deepEqual(tx, FAKE_TX);
  world.calls.push({ store: "recordDecisionMakerValidationLatch", input });
  if (world.latchError) throw world.latchError;
  return world.latchResult;
};

const fakeStore =
  (store: string) =>
  async (tx: unknown, input: Record<string, unknown>) => {
    assert.deepEqual(tx, FAKE_TX);
    world.calls.push({ store, input });
    if (world.storeError) throw world.storeError;
    if (world.storeResult !== undefined) return world.storeResult;
    return ROUTES.find((route) => route.store === store)!.success;
  };

let installed = false;
async function loadRoute(route: Route): Promise<{ POST: (request: Request) => Promise<Response> }> {
  if (!installed) {
    installed = true;
    mock.module(mod("lib/amux/guard.ts"), {
      namedExports: { isAmuxSyncAuthorized: () => world.authorized },
    });
    mock.module(mod("lib/amux/dbBoundary.ts"), {
      namedExports: {
        AMUX_DB_BOUNDARIES: Object.fromEntries([
          ...ROUTES.map((entry) => [entry.boundary, { operation: entry.operation }]),
          [LATCH_BOUNDARY.name, { operation: LATCH_BOUNDARY.operation }],
        ]),
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
          work: (tx: unknown, context: { requireLeaseAt: typeof LEASE }) => Promise<unknown>,
        ) => {
          world.boundaries.push({ operation: boundary.operation, inBudget: world.budgetDepth === 1 });
          return work(FAKE_TX, { requireLeaseAt: LEASE });
        },
      },
    });
    mock.module(mod("lib/amux/decisionMakerBodyStore.ts"), {
      namedExports: {
        DecisionMakerBodyWriteError: FakeBodyWriteError,
        assignDecisionMakerRequestWithDigestKey: fakeStore("assignDecisionMakerRequestWithDigestKey"),
        submitDecisionMakerOutput: fakeStore("submitDecisionMakerOutput"),
      },
    });
    mock.module(mod("lib/amux/decisionMakerRequestStore.ts"), {
      namedExports: {
        DecisionMakerRequestWriteError: FakeRequestWriteError,
        discardDecisionMakerAssignment: fakeStore("discardDecisionMakerAssignment"),
        recordDecisionMakerTransmitIntent: fakeStore("recordDecisionMakerTransmitIntent"),
        recordDecisionMakerTransmitOutcome: fakeStore("recordDecisionMakerTransmitOutcome"),
        lookupDecisionMakerResult: fakeStore("lookupDecisionMakerResult"),
        recordDecisionMakerResultUnknown: fakeStore("recordDecisionMakerResultUnknown"),
        recordDecisionMakerCleanupUnknown: fakeStore("recordDecisionMakerCleanupUnknown"),
        recordDecisionMakerValidationLatch: fakeLatch,
      },
    });
    mock.module(mod("lib/amux/decisionMakerDigestKeys.ts"), {
      namedExports: {
        DecisionMakerDigestKeyError: FakeDigestKeyError,
        loadDecisionMakerDigestKeyRing: () => {
          world.keyRingLoads += 1;
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
    mock.method(console, "warn", (line: unknown) => {
      world.logged.push(String(line));
    });
  }
  return import(mod(route.path));
}

const post = (route: Route, body: unknown) =>
  new Request(`https://tomverse.app${route.url}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

test("only the sync token reaches each route, and each stays closed until the operator enables it", async () => {
  for (const route of ROUTES) {
    const { POST } = await loadRoute(route);

    reset({ authorized: false });
    const unauthorized = await POST(post(route, route.body));
    assert.equal(unauthorized.status, 401, route.name);
    assert.deepEqual(world.calls, [], route.name);
    assert.deepEqual(world.boundaries, [], route.name);

    for (const env of [undefined, "", "true", "ENABLED", "enabled ", "on"]) {
      reset({ env });
      const closed = await POST(post(route, route.body));
      assert.equal(closed.status, 409, `${route.name} ${String(env)}`);
      assert.deepEqual(await closed.json(), { [route.envelope]: false, reason: "dm_routing_disabled" }, route.name);
      assert.equal(closed.headers.get("cache-control"), "no-store", route.name);
      // Closed means no database at all: no boundary, no store, not even the key ring.
      assert.deepEqual(world.boundaries, [], route.name);
      assert.deepEqual(world.calls, [], route.name);
      assert.equal(world.keyRingLoads, 0, route.name);
    }
  }
});

test("an enabled route runs its one store operation in its own boundary inside the route budget", async () => {
  for (const route of ROUTES) {
    const { POST } = await loadRoute(route);
    reset();
    const answer = await POST(post(route, route.body));
    assert.equal(answer.status, 200, route.name);
    assert.equal(answer.headers.get("cache-control"), "no-store", route.name);
    assert.deepEqual(await answer.json(), route.answer, route.name);
    assert.deepEqual(world.boundaries, [{ operation: route.operation, inBudget: true }], route.name);
    // The body's values as they came -- every judgement is the store's -- and the boundary's own
    // lease callback for a deadline write, the key ring for a keyed one.
    assert.deepEqual(world.calls, [{ store: route.store, input: route.input }], route.name);
    assert.equal(world.keyRingLoads, route.keyRing ? 1 : 0, route.name);
    assert.deepEqual(world.logged, [], route.name);
    assert.deepEqual(world.internalErrors, [], route.name);
  }
});

test("a result is a 200 for every definite answer of the ledger, with its status and reason", async () => {
  const route = ROUTES.find((entry) => entry.name === "result submission")!;
  const { POST } = await loadRoute(route);
  const submitted = (result: unknown, extra: Record<string, unknown> = {}) => ({
    status: "submitted",
    resultKind: "proposal",
    validationFailure: null,
    resultDigest: DIGEST_C,
    result,
    detail: null,
    storedFields: [],
    ...extra,
  });
  for (const [storeResult, answer] of [
    [
      submitted({ status: "existing", eventId: EVENT.eventId, resultKind: "proposal" }),
      { status: "existing", event_id: EVENT.eventId, reason: null },
    ],
    // §6: a proposal under the kill switch is recorded as a rejection.
    [
      submitted({ status: "rejected", event: EVENT, reason: "kill_switch" }),
      { status: "rejected", event_id: EVENT.eventId, reason: "kill_switch" },
    ],
    [
      submitted({ status: "already_rejected", reason: "deadline_passed" }),
      { status: "already_rejected", event_id: null, reason: "deadline_passed" },
    ],
  ] as const) {
    reset({ storeResult });
    const response = await POST(post(route, route.body));
    assert.equal(response.status, 200, answer.status);
    assert.deepEqual(
      await response.json(),
      { submitted: true, result_kind: "proposal", validation_failure: null, result_digest: DIGEST_C, ...answer },
      answer.status,
    );
  }
  // A validation failure is a recorded result too, with its class.
  reset({
    storeResult: submitted(
      { status: "accepted", event: EVENT, resultKind: "validation_failure" },
      { resultKind: "validation_failure", validationFailure: "schema" },
    ),
  });
  const failure = await POST(post(route, route.body));
  assert.equal(failure.status, 200);
  assert.deepEqual(await failure.json(), {
    submitted: true,
    status: "accepted",
    result_kind: "validation_failure",
    validation_failure: "schema",
    result_digest: DIGEST_C,
    event_id: EVENT.eventId,
    reason: null,
  });
});

test("a lookup answers what the ledger recorded for the pair, and writes nothing", async () => {
  const route = ROUTES.find((entry) => entry.name === "result lookup")!;
  const { POST } = await loadRoute(route);
  for (const [storeResult, answer] of [
    [{ status: "rejected", reason: "binding_mismatch" }, { status: "rejected", result_kind: null, event_id: null, reason: "binding_mismatch" }],
    [{ status: "not_recorded" }, { status: "not_recorded", result_kind: null, event_id: null, reason: null }],
  ] as const) {
    reset({ storeResult });
    const response = await POST(post(route, route.body));
    assert.equal(response.status, 200, answer.status);
    assert.deepEqual(await response.json(), { found: true, ...answer }, answer.status);
    assert.deepEqual(world.boundaries, [{ operation: "decision_maker_result_lookup_read", inBudget: true }]);
  }
});

test("a body outside each route's strict shape or size never reaches the store", async () => {
  for (const route of ROUTES) {
    const { POST } = await loadRoute(route);
    const oversized = JSON.stringify({ ...route.body, request_id: "x".repeat(route.maxBodyBytes) });
    for (const body of [
      { ...route.body, route: "dm_proposal" },
      { ...route.body, key_ring: "0:abc" },
      [route.body],
      "not json",
      oversized,
    ]) {
      reset();
      const answer = await POST(post(route, body));
      assert.equal(answer.status, 400, route.name);
      assert.deepEqual(await answer.json(), { [route.envelope]: false, reason: "invalid_request" }, route.name);
      assert.deepEqual(world.calls, [], route.name);
      assert.deepEqual(world.boundaries, [], route.name);
      assert.equal(world.keyRingLoads, 0, route.name);
    }
  }
  // The lookup takes the two strings its reader takes; their format is the store's to judge.
  const lookup = ROUTES.find((entry) => entry.name === "result lookup")!;
  const { POST } = await loadRoute(lookup);
  for (const body of [{ request_id: 7, result_digest: DIGEST_C }, { request_id: REQUEST_ID }]) {
    reset();
    assert.equal((await POST(post(lookup, body))).status, 400);
    assert.deepEqual(world.calls, []);
  }
});

test("the result route's size cap holds the largest output the store could accept", async () => {
  // §6's largest answer and rationale, every byte a control character, which JSON writes as six
  // characters and the request body carries as seven, with options as long as §5's card allows.
  const route = ROUTES.find((entry) => entry.name === "result submission")!;
  const { POST } = await loadRoute(route);
  const raw = JSON.stringify({
    kind: "free_text",
    answer: "\u0001".repeat(8 * 1_024),
    rationale: "\u0001".repeat(4 * 1_024),
    irreversible: false,
  });
  const options = [{ id: "a", label: "x".repeat(16 * 1_024) }];
  const body = { ...route.body, output: { kind: "output", raw, options } };
  const bytes = Buffer.byteLength(JSON.stringify(body), "utf8");
  assert.ok(bytes > 96 * 1_024 && bytes < route.maxBodyBytes, String(bytes));
  reset();
  const answer = await POST(post(route, body));
  assert.equal(answer.status, 200);
  assert.equal(world.calls.length, 1);
  assert.equal((world.calls[0]!.input.output as { raw: string }).raw, raw);
});

test("each refusal a store returns has its own answer", async () => {
  for (const route of ROUTES) {
    const { POST } = await loadRoute(route);
    for (const [storeResult, status, reason] of route.refusals) {
      reset({ storeResult });
      const answer = await POST(post(route, route.body));
      assert.equal(answer.status, status, `${route.name} ${reason}`);
      assert.deepEqual(await answer.json(), { [route.envelope]: false, reason }, `${route.name} ${reason}`);
      assert.equal(world.calls.length, 1, route.name);
      assert.deepEqual(world.internalErrors, [], route.name);
    }
  }
});

test("each error a store throws has its own answer, and nothing else is guessed", async () => {
  const thrown: Array<[Error, number, string]> = [
    [new FakeRequestWriteError("invalid_input"), 400, "invalid_input"],
    [new FakeRequestWriteError("key_period_changed"), 409, "dm_key_period_changed"],
    [new FakeRequestWriteError("digest_key_unavailable"), 503, "dm_digest_key_unavailable"],
    [new FakeRequestWriteError("settings_unreadable"), 503, "dm_settings_unreadable"],
    [new FakeRequestWriteError("state_unreadable"), 503, "dm_state_unreadable"],
    [new FakeBodyWriteError("invalid_input"), 400, "invalid_input"],
    [new FakeBodyWriteError("digest_key_unavailable"), 503, "dm_digest_key_unavailable"],
    [new FakeBodyWriteError("state_unreadable"), 503, "dm_state_unreadable"],
  ];
  for (const route of ROUTES) {
    const { POST } = await loadRoute(route);
    for (const [error, status, reason] of thrown) {
      reset({ storeError: error });
      const answer = await POST(post(route, route.body));
      assert.equal(answer.status, status, `${route.name} ${reason}`);
      assert.deepEqual(await answer.json(), { [route.envelope]: false, reason }, `${route.name} ${reason}`);
      assert.deepEqual(world.internalErrors, [], route.name);
    }
    // Anything else -- a boundary deadline, an unknown outcome, a database error, a person's
    // operation no route here calls -- is the shared AMUX internal answer, named for the route.
    for (const other of [new Error("boundary failure"), new FakeBodyWriteError("no_operator")]) {
      reset({ storeError: other });
      const answer = await POST(post(route, route.body));
      assert.equal(answer.status, 500, route.name);
      assert.equal(world.internalErrors.length, 1, route.name);
      assert.equal(world.internalErrors[0]!.operation, route.operation, route.name);
      assert.equal(world.internalErrors[0]!.error, other, route.name);
    }
  }
});

test("a missing or malformed key ring refuses a keyed route before the database, and logs its code only", async () => {
  for (const route of ROUTES.filter((entry) => entry.keyRing)) {
    const { POST } = await loadRoute(route);
    for (const code of ["not_configured", "malformed"]) {
      reset({ keyRingError: new FakeDigestKeyError(code) });
      process.env.AMUX_DM_DIGEST_KEYS = "0:c2VjcmV0LXZhbHVlLXRoYXQtbXVzdC1uZXZlci1sb2c=";
      const answer = await POST(post(route, route.body));
      assert.equal(answer.status, 503, route.name);
      assert.deepEqual(await answer.json(), { [route.envelope]: false, reason: "dm_digest_keys_unavailable" }, route.name);
      assert.deepEqual(world.boundaries, [], route.name);
      assert.deepEqual(world.calls, [], route.name);
      assert.deepEqual(world.logged.map((line) => JSON.parse(line)), [
        { subsystem: "amux", event: "dm_digest_keys_unavailable", code },
      ]);
      assert.doesNotMatch(world.logged.join("\n"), /c2VjcmV0/);
      delete process.env.AMUX_DM_DIGEST_KEYS;
    }
  }
});

test("no answer carries a DM output, a body, the result's detail or the period key", async () => {
  for (const route of ROUTES) {
    const { POST } = await loadRoute(route);
    reset();
    const text = await (await POST(post(route, route.body))).text();
    assert.doesNotMatch(text, /Use the model id only|locale is already|Model id only|dm_answer|irreversible|audit-row-1/, route.name);
    assert.ok(!text.includes(PERIOD_KEY.toString("base64")), route.name);
    assert.ok(!text.includes(PERIOD_KEY.toString("hex")), route.name);
    // The request key goes to the assigned broker in the assignment's answer, and nowhere else.
    assert.equal(text.includes(REQUEST_KEY.toString("base64")), route.name === "assignment", route.name);
  }
});

const withoutComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("the routes write no SQL, read no switch, judge nothing and reach no worker", () => {
  const paths = [...ROUTES.map((route) => route.path), "lib/amux/decisionMakerInternalRoute.ts"];
  for (const path of paths) {
    const source = withoutComments(readFileSync(resolve(ROOT, path), "utf8"));
    // No table is named and no client is opened here: every row is the stores'.
    assert.doesNotMatch(source, /\$queryRaw|\$executeRaw|\$transaction|@\/lib\/prisma|AmuxDecisionMaker[A-Z]/, path);
    // The switches are the stores' to read after the audit chain lock (§6, §8).
    assert.doesNotMatch(source, /decisionMakerSwitch|killSwitch/, path);
    // The routing and the ledger writes the body store composes are reached only through it.
    assert.doesNotMatch(source, /\b(recordDecisionMakerRequest|assignDecisionMakerRequest|submitDecisionMakerResult)\(/, path);
    // No judgment, delivery or card write: nothing here reaches a worker (§1, §12).
    assert.doesNotMatch(source, /decisionMakerJudgment|deliver|AmuxWorkItem/i, path);
    // No log line but the key ring loader's code and, since 2026-10-17, the latch check's.
    const logs = source.match(/console\.\w+\([^;]*;/g) ?? [];
    assert.deepEqual(
      logs,
      path.startsWith("lib/")
        ? [
            'console.warn(JSON.stringify({ subsystem: "amux", event: "dm_validation_latch_unsettled", code: latchErrorCode(error) }));',
            'console.error(JSON.stringify({ subsystem: "amux", event: "dm_digest_keys_unavailable", code: error.code }));',
          ]
        : [],
      path,
    );
  }
});

test("a validation failure the ledger holds runs §8's latch check in a boundary of its own, and the answer stays the result's", async () => {
  const route = ROUTES.find((entry) => entry.name === "result submission")!;
  const { POST } = await loadRoute(route);
  const submitted = (result: Record<string, unknown>, resultKind: string) => ({
    status: "submitted",
    resultKind,
    validationFailure: resultKind === "validation_failure" ? "unknown_option" : null,
    resultDigest: DIGEST_C,
    result,
    detail: null,
    storedFields: [],
  });
  const failure = (status: "accepted" | "existing") =>
    submitted(
      status === "accepted"
        ? { status, event: EVENT, resultKind: "validation_failure" }
        : { status, eventId: EVENT.eventId, resultKind: "validation_failure" },
      "validation_failure",
    );
  const expected = (status: string) => ({
    submitted: true,
    status,
    result_kind: "validation_failure",
    validation_failure: "unknown_option",
    result_digest: DIGEST_C,
    event_id: EVENT.eventId,
    reason: null,
  });

  // Accepted now or already: the check runs for the instance, after the result's own boundary.
  for (const status of ["accepted", "existing"] as const) {
    for (const latchResult of [{ latched: true, event: LATCH_EVENT }, { latched: false, reason: "no_streak" }, { latched: false, reason: "already_latched" }]) {
      reset({ storeResult: failure(status), latchResult });
      const answer = await POST(post(route, route.body));
      assert.equal(answer.status, 200, status);
      // The same answer whatever the check did: no latch field, no switch event id.
      assert.deepEqual(await answer.json(), expected(status), status);
      assert.deepEqual(world.boundaries, [
        { operation: route.operation, inBudget: true },
        { operation: LATCH_BOUNDARY.operation, inBudget: true },
      ]);
      assert.deepEqual(world.calls.map((call) => call.store), ["submitDecisionMakerOutput", "recordDecisionMakerValidationLatch"]);
      assert.deepEqual(world.calls[1]!.input, { instance: "decision-maker-openai" });
      assert.deepEqual(world.logged, []);
    }
  }

  // A check that cannot be written leaves the answer alone, and logs its code only.
  for (const [error, code] of [
    [Object.assign(new Error("database said something with a value in it"), { name: "AmuxDbBoundaryError", code: "AMUX_DB_OUTCOME_UNKNOWN" }), "AMUX_DB_OUTCOME_UNKNOWN"],
    [new FakeRequestWriteError("settings_unreadable"), null],
    [new Error("relation does not exist"), null],
  ] as const) {
    reset({ storeResult: failure("accepted"), latchError: error });
    const answer = await POST(post(route, route.body));
    assert.equal(answer.status, 200);
    assert.deepEqual(await answer.json(), expected("accepted"));
    assert.deepEqual(world.logged.map((line) => JSON.parse(line)), [
      { subsystem: "amux", event: "dm_validation_latch_unsettled", code },
    ]);
    assert.doesNotMatch(world.logged.join("\n"), /value in it|relation/);
    assert.deepEqual(world.internalErrors, []);
  }

  // Any other answer of the ledger is not a validation failure it holds: no check.
  for (const storeResult of [
    submitted({ status: "accepted", event: EVENT, resultKind: "proposal" }, "proposal"),
    submitted({ status: "existing", eventId: EVENT.eventId, resultKind: "escalate" }, "escalate"),
    submitted({ status: "accepted", event: EVENT, resultKind: "timeout" }, "timeout"),
    submitted({ status: "rejected", event: EVENT, reason: "deadline_passed" }, "validation_failure"),
    submitted({ status: "already_rejected", reason: "request_closed" }, "validation_failure"),
  ]) {
    reset({ storeResult });
    assert.equal((await POST(post(route, route.body))).status, 200);
    assert.deepEqual(world.boundaries, [{ operation: route.operation, inBudget: true }], JSON.stringify(storeResult.result));
    assert.deepEqual(world.calls.map((call) => call.store), ["submitDecisionMakerOutput"]);
  }

  // A refusal writes nothing, so it runs no check either.
  reset({ storeResult: { status: "option_set_mismatch" } });
  assert.equal((await POST(post(route, route.body))).status, 409);
  assert.deepEqual(world.calls.map((call) => call.store), ["submitDecisionMakerOutput"]);
});
