import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mock, test } from "node:test";

// AMUX Decision Maker stage S2-2b3 (docs/policy/amux-decision-maker.md §2-7,
// §6, §9): the three routes the bridge relay calls to deliver an
// operator-confirmed answer -- the next confirmed answer, the delivery
// decision, and the delivery's receipt or unknown outcome (since stage S2-2b4
// also a not-sent outcome with its reason) -- and stage S2-2b4's two: the
// decision with no outcome a bridge reads at its start, and the close of a
// request whose question the operator answered directly. Only the sync token
// reaches them; each stays closed until the operator enables it and then
// touches nothing; a body outside its strict shape or size never reaches the
// store; each runs its one store operation in its own DB boundary inside the
// route budget; under the kill switch the read gives no answer; and what the
// store returns or throws each has its own answer. The stores are faked; their
// statements are counted in tests/amuxDecisionMakerDelivery.test.mjs and their
// transactions run against PostgreSQL in
// tests/integration/amux-decision-maker-delivery.db.test.ts.

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relative: string) => pathToFileURL(resolve(ROOT, relative)).href;
const require = createRequire(import.meta.url);

class FakeJudgmentWriteError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
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

const REQUEST_ID = "11111111-2222-4333-8444-555555555555";
const EVENT = { eventId: "22222222-3333-4444-8555-666666666666", auditLogId: "audit-row-1", sequence: "7", createdAt: "2026-10-18T00:00:00.000Z" };
const MESSAGE = "[Decision Maker decision-maker-openai (GPT-6 Astra) 제안, operator-confirmed, re AMUX-12]\n선택지: sqlite\n\n승인 계약의 승인이 아니다. 사람 승인이 필요한 게이트는 따로 요청한다.";
const READY = {
  status: "ready",
  requestId: REQUEST_ID,
  judgedAtMs: 1_790_000_000_000,
  judgmentKind: "confirm",
  instance: "decision-maker-openai",
  cardId: "AMUX-12",
  questionRevision: 3,
  askingWorkerId: "claude-impl",
  session: "claude-impl",
  sessionAttempt: 2,
  messageId: `dm-answer:${REQUEST_ID}`,
  message: MESSAGE,
};

type World = {
  authorized: boolean;
  env: string | undefined;
  budgetDepth: number;
  boundaries: Array<{ operation: string; inBudget: boolean }>;
  calls: Array<{ store: string; input: Record<string, unknown> }>;
  storeResult: unknown;
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
    storeResult: undefined,
    storeError: null,
    internalErrors: [],
    logged: [],
    ...changes,
  };
  if (world.env === undefined) delete process.env.TOMVERSE_AMUX_DM_ROUTING;
  else process.env.TOMVERSE_AMUX_DM_ROUTING = world.env;
};
reset();

const FAKE_TX = { fake: "tx" };

type Route = {
  name: string;
  /** The thrown errors this route's own answer names (the request store's route uses the shared one). */
  errors?: "delivery" | "request";
  path: string;
  url: string;
  boundary: string;
  operation: string;
  store: string;
  envelope: "recorded" | "found";
  maxBodyBytes: number;
  body: Record<string, unknown>;
  input: Record<string, unknown>;
  success: unknown;
  answer: Record<string, unknown>;
  refusals: Array<[unknown, number, string]>;
};

const ROUTES: Route[] = [
  {
    name: "next confirmed answer",
    path: "app/api/internal/amux/decision-maker/deliveries/next/route.ts",
    url: "/api/internal/amux/decision-maker/deliveries/next",
    boundary: "decisionMakerDeliveryCandidateRead",
    operation: "decision_maker_delivery_candidate_read",
    store: "readDecisionMakerDeliveryCandidate",
    envelope: "found",
    maxBodyBytes: 1_024,
    body: { after: { judged_at_ms: 5, request_id: REQUEST_ID } },
    input: { after: { judgedAtMs: 5, requestId: REQUEST_ID } },
    success: READY,
    answer: {
      found: true,
      status: "ready",
      delivery: {
        request_id: REQUEST_ID,
        judged_at_ms: READY.judgedAtMs,
        judgment_kind: "confirm",
        instance: "decision-maker-openai",
        card_id: "AMUX-12",
        question_revision: 3,
        // The binding the local AMUX holds the card to (review r-20261018-065705-65cb2a).
        worker: "claude-impl",
        session: "claude-impl",
        session_attempt: 2,
        message_id: READY.messageId,
        message: MESSAGE,
      },
    },
    // §6's table: "bridge의 확정 답 조회·전달 — 거부".
    refusals: [[{ status: "kill_switch_on" }, 409, "kill_switch_on"]],
  },
  {
    name: "delivery decision",
    path: "app/api/internal/amux/decision-maker/deliveries/route.ts",
    url: "/api/internal/amux/decision-maker/deliveries",
    boundary: "decisionMakerDeliveryDecision",
    operation: "decision_maker_delivery_decision",
    store: "recordDecisionMakerDelivery",
    envelope: "recorded",
    maxBodyBytes: 1_024,
    body: { request_id: REQUEST_ID },
    input: { requestId: REQUEST_ID },
    success: { recorded: true, event: EVENT, judgmentKind: "edit_confirm" },
    answer: { recorded: true, event_id: EVENT.eventId, created_at: EVENT.createdAt, judgment_kind: "edit_confirm" },
    refusals: [
      [{ recorded: false, reason: "not_confirmed" }, 409, "not_confirmed"],
      [{ recorded: false, reason: "already_delivered" }, 409, "already_delivered"],
      [{ recorded: false, reason: "kill_switch_on" }, 409, "kill_switch_on"],
      [{ recorded: false, reason: "settings_unreadable" }, 503, "settings_unreadable"],
    ],
  },
  {
    name: "delivery outcome",
    path: "app/api/internal/amux/decision-maker/deliveries/outcome/route.ts",
    url: "/api/internal/amux/decision-maker/deliveries/outcome",
    boundary: "decisionMakerDeliveryOutcome",
    operation: "decision_maker_delivery_outcome",
    store: "recordDecisionMakerDeliveryOutcome",
    envelope: "recorded",
    maxBodyBytes: 1_024,
    body: { request_id: REQUEST_ID, outcome: "unknown" },
    input: { requestId: REQUEST_ID, outcome: "unknown", reason: undefined },
    success: { recorded: true, event: EVENT, judgmentKind: "confirm" },
    answer: { recorded: true, event_id: EVENT.eventId, created_at: EVENT.createdAt },
    refusals: [
      [{ recorded: false, reason: "not_delivered" }, 409, "not_delivered"],
      [{ recorded: false, reason: "outcome_recorded" }, 409, "outcome_recorded"],
    ],
  },
  {
    // Stage S2-2b4: the same route, a delivery the local AMUX proved sent nothing.
    name: "delivery not sent",
    path: "app/api/internal/amux/decision-maker/deliveries/outcome/route.ts",
    url: "/api/internal/amux/decision-maker/deliveries/outcome",
    boundary: "decisionMakerDeliveryOutcome",
    operation: "decision_maker_delivery_outcome",
    store: "recordDecisionMakerDeliveryOutcome",
    envelope: "recorded",
    maxBodyBytes: 1_024,
    body: { request_id: REQUEST_ID, outcome: "not_sent", reason: "answered_by_operator" },
    input: { requestId: REQUEST_ID, outcome: "not_sent", reason: "answered_by_operator" },
    success: { recorded: true, event: EVENT, judgmentKind: "confirm" },
    answer: { recorded: true, event_id: EVENT.eventId, created_at: EVENT.createdAt },
    refusals: [
      [{ recorded: false, reason: "not_delivered" }, 409, "not_delivered"],
      [{ recorded: false, reason: "outcome_recorded" }, 409, "outcome_recorded"],
    ],
  },
  {
    name: "unsettled decision",
    path: "app/api/internal/amux/decision-maker/deliveries/unsettled/route.ts",
    url: "/api/internal/amux/decision-maker/deliveries/unsettled",
    boundary: "decisionMakerDeliveryUnsettledRead",
    operation: "decision_maker_delivery_unsettled_read",
    store: "readDecisionMakerUnsettledDelivery",
    envelope: "found",
    maxBodyBytes: 256,
    body: {},
    input: undefined as unknown as Record<string, unknown>,
    success: {
      status: "unsettled",
      requestId: REQUEST_ID,
      decidedAtMs: 1_790_000_000_500,
      cardId: "AMUX-12",
      questionRevision: 3,
      askingWorkerId: "claude-impl",
      session: "claude-impl",
      sessionAttempt: 2,
      messageId: `dm-answer:${REQUEST_ID}`,
    },
    answer: {
      found: true,
      status: "unsettled",
      delivery: {
        request_id: REQUEST_ID,
        decided_at_ms: 1_790_000_000_500,
        card_id: "AMUX-12",
        question_revision: 3,
        worker: "claude-impl",
        session: "claude-impl",
        session_attempt: 2,
        message_id: `dm-answer:${REQUEST_ID}`,
      },
    },
    refusals: [],
  },
  {
    name: "direct answer close",
    path: "app/api/internal/amux/decision-maker/requests/direct-answer/route.ts",
    url: "/api/internal/amux/decision-maker/requests/direct-answer",
    boundary: "decisionMakerDirectAnswerClose",
    operation: "decision_maker_direct_answer_close",
    store: "closeDecisionMakerRequestOnDirectAnswer",
    envelope: "recorded",
    errors: "request",
    maxBodyBytes: 1_024,
    body: { card_id: "AMUX-12", question_revision: 3 },
    input: { cardId: "AMUX-12", questionRevision: 3 },
    success: { recorded: true, event: { ...EVENT, resultDeadlineAt: null } },
    answer: { recorded: true, event_id: EVENT.eventId, created_at: EVENT.createdAt },
    refusals: [
      [{ recorded: false, reason: "unknown_request" }, 404, "unknown_request"],
      [{ recorded: false, reason: "not_routed_to_dm" }, 409, "not_routed_to_dm"],
      [{ recorded: false, reason: "closed" }, 409, "closed"],
    ],
  },
];

const fakeStore =
  (store: string) =>
  async (tx: unknown, input: Record<string, unknown>) => {
    assert.deepEqual(tx, FAKE_TX);
    world.calls.push({ store, input });
    if (world.storeError) throw world.storeError;
    if (world.storeResult !== undefined) return world.storeResult;
    return (currentRoute?.store === store ? currentRoute : ROUTES.find((route) => route.store === store)!).success;
  };
let currentRoute: Route | null = null;

let installed = false;
async function loadRoute(route: Route): Promise<{ POST: (request: Request) => Promise<Response> }> {
  if (!installed) {
    installed = true;
    mock.module(mod("lib/amux/guard.ts"), {
      namedExports: { isAmuxSyncAuthorized: () => world.authorized },
    });
    mock.module(mod("lib/amux/dbBoundary.ts"), {
      namedExports: {
        AMUX_DB_BOUNDARIES: Object.fromEntries(ROUTES.map((entry) => [entry.boundary, { operation: entry.operation }])),
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
          return work(FAKE_TX);
        },
      },
    });
    mock.module(mod("lib/amux/decisionMakerDeliveryRead.ts"), {
      namedExports: {
        readDecisionMakerDeliveryCandidate: fakeStore("readDecisionMakerDeliveryCandidate"),
        // The unsettled read takes no input; the fake records undefined.
        readDecisionMakerUnsettledDelivery: (tx: unknown) => fakeStore("readDecisionMakerUnsettledDelivery")(tx, undefined as never),
      },
    });
    mock.module(mod("lib/amux/decisionMakerJudgmentStore.ts"), {
      namedExports: {
        DecisionMakerJudgmentWriteError: FakeJudgmentWriteError,
        recordDecisionMakerDelivery: fakeStore("recordDecisionMakerDelivery"),
        recordDecisionMakerDeliveryOutcome: fakeStore("recordDecisionMakerDeliveryOutcome"),
      },
    });
    // The shared error answer (lib/amux/decisionMakerInternalRoute.ts) names these stores' error classes.
    mock.module(mod("lib/amux/decisionMakerRequestStore.ts"), {
      namedExports: {
        DecisionMakerRequestWriteError: FakeRequestWriteError,
        closeDecisionMakerRequestOnDirectAnswer: fakeStore("closeDecisionMakerRequestOnDirectAnswer"),
        recordDecisionMakerValidationLatch: async () => ({ latched: false }),
        recordDecisionMakerCleanupLatch: async () => ({ latched: false }),
      },
    });
    mock.module(mod("lib/amux/decisionMakerBodyStore.ts"), {
      namedExports: { DecisionMakerBodyWriteError: FakeBodyWriteError },
    });
    mock.module(mod("lib/amux/decisionMakerDigestKeys.ts"), {
      namedExports: { DecisionMakerDigestKeyError: FakeDigestKeyError },
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
  currentRoute = route;
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
      assert.deepEqual(world.boundaries, [], route.name);
      assert.deepEqual(world.calls, [], route.name);
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
    assert.deepEqual(world.calls, [{ store: route.store, input: route.input }], route.name);
    // The message travels in the answer and nowhere else.
    assert.deepEqual(world.logged, [], route.name);
    assert.deepEqual(world.internalErrors, [], route.name);
  }
});

test("the read gives no answer under the kill switch, nothing when there is none, and steps past an erased one", async () => {
  const route = ROUTES[0]!;
  const { POST } = await loadRoute(route);
  for (const [storeResult, status, answer] of [
    [{ status: "kill_switch_on" }, 409, { found: false, reason: "kill_switch_on" }],
    [{ status: "none" }, 200, { found: true, status: "none", delivery: null }],
    [
      { status: "undeliverable", requestId: REQUEST_ID, judgedAtMs: 9, reason: "answer_body_missing" },
      200,
      { found: true, status: "undeliverable", delivery: { request_id: REQUEST_ID, judged_at_ms: 9, reason: "answer_body_missing" } },
    ],
  ] as const) {
    reset({ storeResult });
    const response = await POST(post(route, route.body));
    assert.equal(response.status, status);
    const body = await response.json();
    assert.deepEqual(body, answer);
    assert.ok(!JSON.stringify(body).includes("선택지"), "no answer under the kill switch, none or undeliverable");
  }
  // The start of the walk is `after: null`.
  reset();
  await POST(post(route, { after: null }));
  assert.deepEqual(world.calls, [{ store: route.store, input: { after: null } }]);
});

test("a body outside the strict shape or size never reaches the store", async () => {
  for (const route of ROUTES) {
    const { POST } = await loadRoute(route);
    for (const bad of [
      "not json",
      { ...route.body, extra: 1 },
      JSON.stringify({ ...route.body, padding: "x".repeat(route.maxBodyBytes) }),
    ]) {
      reset();
      const response = await POST(post(route, bad));
      assert.equal(response.status, 400, `${route.name} ${String(bad).slice(0, 20)}`);
      assert.deepEqual(world.calls, [], route.name);
    }
  }
  // A malformed cursor is refused before any boundary opens.
  const { POST } = await loadRoute(ROUTES[0]!);
  for (const after of [{ judged_at_ms: -1, request_id: REQUEST_ID }, { judged_at_ms: 1, request_id: "x" }, "start"]) {
    reset();
    const response = await POST(post(ROUTES[0]!, { after }));
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { found: false, reason: "invalid_input" });
    assert.deepEqual(world.boundaries, []);
  }
});

test("each refusal the store returns has its status and reason; a write refusal wrote nothing", async () => {
  for (const route of ROUTES) {
    const { POST } = await loadRoute(route);
    for (const [storeResult, status, reason] of route.refusals) {
      reset({ storeResult });
      const response = await POST(post(route, route.body));
      assert.equal(response.status, status, `${route.name} ${reason}`);
      assert.deepEqual(await response.json(), { [route.envelope]: false, reason }, `${route.name} ${reason}`);
    }
  }
});

test("a thrown store error has its own answer and never claims a write that may have committed", async () => {
  for (const route of ROUTES) {
    const { POST } = await loadRoute(route);
    const errors =
      route.errors === "request"
        ? ([
            [new FakeRequestWriteError("invalid_input"), 400, "invalid_input"],
            [new FakeRequestWriteError("state_unreadable"), 503, "dm_state_unreadable"],
            [new FakeBodyWriteError("state_unreadable"), 503, "dm_state_unreadable"],
          ] as const)
        : ([
            [new FakeJudgmentWriteError("invalid_input"), 400, "invalid_input"],
            [new FakeJudgmentWriteError("settings_unreadable"), 503, "dm_settings_unreadable"],
            [new FakeJudgmentWriteError("state_unreadable"), 503, "dm_state_unreadable"],
            [new FakeRequestWriteError("state_unreadable"), 503, "dm_state_unreadable"],
            [new FakeBodyWriteError("state_unreadable"), 503, "dm_state_unreadable"],
          ] as const);
    for (const [error, status, reason] of errors) {
      reset({ storeError: error });
      const response = await POST(post(route, route.body));
      assert.equal(response.status, status, `${route.name} ${reason}`);
      assert.deepEqual(await response.json(), { [route.envelope]: false, reason }, `${route.name} ${reason}`);
    }
    // Anything else -- a deadline, an outcome the database left unknown -- is the shared answer.
    const unknown = Object.assign(new Error("amux outcome unknown"), { name: "AmuxDbBoundaryError", code: "AMUX_DB_OUTCOME_UNKNOWN" });
    reset({ storeError: unknown });
    const response = await POST(post(route, route.body));
    assert.equal(response.status, 500, route.name);
    assert.deepEqual(world.internalErrors, [{ operation: route.operation, error: unknown }], route.name);
  }
});

test("stage S2-2b4: the unsettled read carries no answer, and a direct answer's report carries no text", async () => {
  {
    const route = ROUTES.find((entry) => entry.name === "unsettled decision")!;
    const { POST } = await loadRoute(route);
    reset({ storeResult: { status: "none" } });
    const none = await POST(post(route, {}));
    assert.equal(none.status, 200);
    assert.deepEqual(await none.json(), { found: true, status: "none", delivery: null });
    reset();
    const body = await (await POST(post(route, {}))).json();
    assert.ok(!JSON.stringify(body).includes("message\""), "no message, only what to look up");
    // It reads under the kill switch as well: it records nothing and releases nothing (section 6's table).
    assert.deepEqual(world.boundaries, [{ operation: route.operation, inBudget: true }]);
  }
  {
    const route = ROUTES.find((entry) => entry.name === "direct answer close")!;
    const { POST } = await loadRoute(route);
    for (const bad of [{ card_id: "AMUX-12", question_revision: 3, answer: "Use the model id." }, { card_id: "AMUX-12" }]) {
      reset();
      const response = await POST(post(route, bad));
      // An extra key and a missing one are both refused by the strict body, unread by the store.
      assert.equal(response.status, 400, JSON.stringify(bad));
      assert.deepEqual(world.calls, [], JSON.stringify(bad));
    }
  }
});
