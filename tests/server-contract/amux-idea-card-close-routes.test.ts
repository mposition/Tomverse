import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { before, mock, test } from "node:test";

// Closing a stalled idea's cards (docs/policy/amux-decision-maker.md §2-10): the
// relay's three v22 question routes carry the new question with no change the
// bridge can see, and the owner's route keeps its gates. The stores are faked;
// their transactions run against PostgreSQL in
// tests/integration/amux-idea-card-close.db.test.ts.

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relative: string) => pathToFileURL(resolve(ROOT, relative)).href;

class FakeBoardImportError extends Error {
  constructor(readonly code: string, readonly httpStatus: number) { super(code); }
}
class FakeOwnerError extends Error {
  constructor(readonly code: string) { super(code); }
}
class FakeReauth extends Error {}

const QUESTION = "11111111-2222-4333-8444-555555555555";
const OTHER = "22222222-3333-4444-8555-666666666666";
const IDEA = "33333333-4444-4555-8666-777777777777";

type World = {
  authorized: boolean; routing: string | undefined;
  session: unknown; role: string; admin: boolean; reauthRequired: boolean; originValid: boolean;
  v22Pending: unknown[]; v22Closing: unknown[];
  closePending: unknown[]; closeClosing: unknown[];
  openError: Error | null; resolved: unknown; ownerResult: unknown; ownerError: Error | null; question: unknown;
  direct: unknown; directInput: unknown;
  calls: string[]; boundaries: string[]; ownerInput: unknown; recordedInput: unknown;
  reviewPending: unknown[]; reviewClosing: unknown[]; autoApplied: unknown; autoCalls: number;
  t2Pending: unknown[]; t2Closing: unknown[]; t2Unfilable: string[]; t2Recorded: unknown;
  settlementPending: unknown[]; settlementClosing: unknown[]; settlementEnabled: boolean | null;
  /** The settlements the owner asked for from the owner queue: the only ones read while the switch is off. */
  settlementRequested: unknown[];
  heartbeats: number;
};
let world: World;
const reset = (changes: Partial<World> = {}) => {
  world = {
    authorized: true, routing: "enabled",
    session: { user: { id: "owner-1", email: "owner@example.test" } }, role: "owner", admin: true,
    reauthRequired: false, originValid: true,
    v22Pending: [], v22Closing: [], closePending: [], closeClosing: [],
    openError: null, resolved: null, ownerResult: { outcome: "closed", closedCards: 2, auditId: "a" },
    ownerError: null, question: null, direct: null, directInput: null, calls: [], boundaries: [], ownerInput: null, recordedInput: null,
    reviewPending: [], reviewClosing: [], autoApplied: null, autoCalls: 0,
    t2Pending: [], t2Closing: [], t2Unfilable: [], t2Recorded: null,
    settlementPending: [], settlementClosing: [], settlementEnabled: null,
    settlementRequested: [],
    heartbeats: 0,
    ...changes,
  };
  if (world.routing === undefined) delete process.env.TOMVERSE_AMUX_DM_ROUTING;
  else process.env.TOMVERSE_AMUX_DM_ROUTING = world.routing;
};
reset();

mock.module("next-auth/next", { namedExports: {
  getServerSession: async () => world.session,
} });
mock.module(mod("lib/auth.ts"), { namedExports: { authOptions: {} } });
mock.module(mod("lib/adminAuth.ts"), { namedExports: {
  getAdminRole: () => world.role,
  isAdminSession: () => world.admin,
} });
mock.module(mod("lib/adminReauthentication.ts"), { namedExports: {
  assertRecentAdminAuthentication: async () => { if (world.reauthRequired) throw new FakeReauth("reauth"); },
  isAdminReauthenticationError: (error: unknown) => error instanceof FakeReauth,
} });
mock.module(mod("lib/requestOrigin.ts"), { namedExports: { hasValidMutationOrigin: () => world.originValid } });
mock.module(mod("lib/amux/boardImportCore.ts"), { namedExports: { BoardImportError: FakeBoardImportError } });
mock.module(mod("lib/amux/guard.ts"), { namedExports: { isAmuxSyncAuthorized: () => world.authorized } });
mock.module(mod("lib/amux/internalRoute.ts"), { namedExports: {
  amuxJsonNoStore: (body: unknown, status = 200) => Response.json(body, { status }),
  amuxInternalErrorResponse: () => Response.json({ error: "internal" }, { status: 500 }),
  isAmuxInputError: () => false,
} });
mock.module(mod("lib/amux/decisionMakerInternalRoute.ts"), { namedExports: {
  dmInternalRoutesEnabled: () => process.env.TOMVERSE_AMUX_DM_ROUTING === "enabled",
  dmRouteErrorResponse: () => Response.json({ error: "internal" }, { status: 500 }),
  dmRouteRefusal: (envelope: string) => (status: number, reason: string) =>
    Response.json({ [envelope]: false, reason }, { status }),
} });
mock.module(mod("lib/amux/dbBoundary.ts"), { namedExports: {
  AMUX_DB_BOUNDARIES: new Proxy({}, { get: (_target, name) => ({ operation: String(name) }) }),
  withAmuxDbBoundary: async (boundary: { operation: string },
    work: (tx: unknown, context: { dbNow: Date }) => Promise<unknown>) => {
    world.boundaries.push(boundary.operation);
    return work({ fake: "tx" }, { dbNow: new Date("2026-11-05T00:00:00.000Z") });
  },
  withAmuxRouteBudget: async (work: () => Promise<unknown>) => work(),
} });
mock.module(mod("lib/amux/dmRelayHeartbeat.ts"), { namedExports: {
  recordAmuxDmRelaySync: async () => { world.heartbeats += 1; },
} });
mock.module(mod("lib/amux/decisionMakerDeliveryCore.ts"), { namedExports: {
  parseDmDeliveryCursor: (value: unknown) => value === "bad" ? undefined : value ?? null,
} });
mock.module(mod("lib/amux/v22OwnerQuestionDmService.ts"), { namedExports: {
  AMUX_V22_QUESTION_SYNC_LIMIT: 3,
  openAmuxV22QuestionCards: async (pending: unknown[]) => pending,
  readAmuxV22QuestionSyncRows: async () => ({ pending: world.v22Pending, closing: world.v22Closing,
    refusalCards: [] }),
  runAmuxV22ResolveStep: async () => { world.calls.push("walk"); return { resolved: world.resolved, cursor: { move: "keep" } }; },
  recordDmQuestionLocalCard: async (_tx: unknown, input: unknown) => {
    world.recordedInput = input; return { recorded: true };
  },
  recordDmQuestionLocalCardClosed: async (_tx: unknown, input: unknown) => {
    world.recordedInput = input; return { recorded: true };
  },
} });
mock.module(mod("lib/amux/dmAutoApplyService.ts"), { namedExports: {
  runAmuxDmAutoApplyStep: async () => { world.autoCalls += 1; return world.autoApplied; },
} });
mock.module(mod("lib/amux/v22ResultReviewService.ts"), { namedExports: {
  readAmuxV22ResultReviewSyncRows: async () => ({ pending: world.reviewPending, closing: world.reviewClosing }),
  openAmuxV22ResultReviewCards: async (pending: unknown[]) => ({ cards: pending, unfilable: [] }),
  recordAmuxV22ResultReviewsUnfilable: async () => ({ recorded: 0 }),
} });
mock.module(mod("lib/amux/dmOwnerSettlementService.ts"), { namedExports: {
  readAmuxDmOwnerSettlementSyncRows: async (_tx: unknown, input: { enabled: boolean }) => {
    world.settlementEnabled = input.enabled;
    return { pending: input.enabled ? world.settlementPending : world.settlementRequested, siblings: [], pulls: [],
      closing: world.settlementClosing };
  },
  openAmuxDmOwnerSettlementCards: async (rows: { pending: unknown[] }) => ({ cards: rows.pending, unfilable: [] }),
  recordAmuxDmOwnerSettlementsUnfilable: async () => ({ recorded: 0 }),
} });
mock.module(mod("lib/amux/dmOwnerSettlementRemake.ts"), { namedExports: {
  resumeAmuxDmOwnerSettlementRemake: async () => { world.calls.push("remake-resume"); return null; },
} });
mock.module(mod("lib/engineeringAgentT2DmReviewService.ts"), { namedExports: {
  readEngineeringAgentT2DmSyncRows: async () => ({ pending: world.t2Pending, closing: world.t2Closing }),
  engineeringAgentT2DmCards: (pending: unknown[]) => ({ cards: pending, unfilable: world.t2Unfilable }),
  recordEngineeringAgentT2DmUnfilable: async (_tx: unknown, input: unknown) => {
    world.t2Recorded = input; return { recorded: 1 };
  },
} });
mock.module(mod("lib/amux/ideaCardCloseService.ts"), { namedExports: {
  openAmuxIdeaCardCloseQuestionIfDue: async () => {
    world.calls.push("open");
    if (world.openError) throw world.openError;
    return { opened: false };
  },
  readAmuxIdeaCardCloseSyncForRelay: async () => {
    world.calls.push("close-read");
    return { pending: world.closePending, closing: world.closeClosing };
  },
  readAmuxIdeaCardCloseOwnerState: async (input: unknown) => {
    world.ownerInput = input; return { question: world.question, direct: world.direct };
  },
} });
mock.module(mod("lib/amux/ideaCardCloseOwnerService.ts"), { namedExports: {
  AmuxIdeaCardCloseOwnerError: FakeOwnerError,
  answerAmuxIdeaCardCloseForOwner: async (input: unknown) => {
    world.ownerInput = input;
    if (world.ownerError) throw world.ownerError;
    return world.ownerResult;
  },
  closeAmuxIdeaCardsDirectlyForOwner: async (input: unknown) => {
    world.directInput = input;
    if (world.ownerError) throw world.ownerError;
    return world.ownerResult;
  },
} });
mock.module(mod("lib/apiSecurity.ts"), { namedExports: {
  apiSecurityResponse: () => null,
  consumeApiRateLimit: async () => undefined,
  readLimitedJson: async (request: Request, _limit: number, schema: { parse: (value: unknown) => unknown }) =>
    schema.parse(await request.json()),
} });

type Route = { POST: (request: Request) => Promise<Response>; GET: (request: Request) => Promise<Response> };
const load = async (relative: string) => (await import(mod(relative))) as Route;
let syncRoute: Route;
let cardRoute: Route;
let closedRoute: Route;
let ownerRoute: Route;
before(async () => {
  syncRoute = await load("app/api/internal/amux/decision-maker/v22-questions/sync/route.ts");
  cardRoute = await load("app/api/internal/amux/decision-maker/v22-questions/card/route.ts");
  closedRoute = await load("app/api/internal/amux/decision-maker/v22-questions/closed/route.ts");
  ownerRoute = await load("app/api/admin/amux/ideas/card-close/route.ts");
});

const post = (body: unknown) => new Request("https://tomverse.test/route", { method: "POST",
  headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const v22Entry = (id: string) => ({ question_id: id, worker: "codex-impl" });
const closeEntry = (id: string) => ({ question_id: id, worker: "amux-card-close" });

test("the sync lists a card close question beside the v22 ones, three at most, in the shape the bridge reads", async () => {
  reset({ closePending: [closeEntry(QUESTION)], closeClosing: [{ questionId: OTHER, cardId: "CC-1" }],
    resolved: "closed" });
  const response = await syncRoute.POST(post({}));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body, { synced: true, resolved: "closed", cursor: { move: "keep" },
    pending: [closeEntry(QUESTION)], closing: [{ question_id: OTHER, card_id: "CC-1" }] });
  assert.deepEqual(world.calls, ["walk", "open", "close-read", "remake-resume"], "the walk first, as before");

  reset({ v22Pending: [v22Entry("a"), v22Entry("b"), v22Entry("c")], closePending: [closeEntry(QUESTION)],
    v22Closing: [{ questionId: "a", cardId: "1" }, { questionId: "b", cardId: "2" }, { questionId: "c", cardId: "3" }],
    closeClosing: [{ questionId: "d", cardId: "4" }] });
  const full = await (await syncRoute.POST(post({}))).json();
  assert.deepEqual(full.pending.map((entry: { question_id: string }) => entry.question_id), ["a", "b", "c"],
    "v22 first; the next tick lists what is left");
  assert.deepEqual(full.closing.map((entry: { question_id: string }) => entry.question_id), ["a", "b", "c"]);
});

test("a v22 result review rides the same tick after the others, filed only while its switch is on", async () => {
  const reviewEntry = { question_id: OTHER, worker: "amux-result-review" };
  delete process.env.TOMVERSE_AMUX_V22_RESULT_REVIEW_DM;
  reset({ reviewPending: [reviewEntry], reviewClosing: [{ questionId: QUESTION, cardId: "RR-1" }] });
  const off = await (await syncRoute.POST(post({}))).json();
  assert.deepEqual(off.pending, [], "no new review card while the switch is off");
  assert.deepEqual(off.closing, [{ question_id: QUESTION, card_id: "RR-1" }], "its cards still close");
  assert.equal(world.autoCalls, 1, "the DM approver step runs once per tick (it checks its own switch)");
  assert.ok(world.boundaries.includes("decisionMakerV22ResultReviewRead"));
  process.env.TOMVERSE_AMUX_V22_RESULT_REVIEW_DM = "enabled";
  try {
    reset({ v22Pending: [v22Entry("a")], closePending: [closeEntry(QUESTION)], reviewPending: [reviewEntry],
      autoApplied: { requestId: "r", kind: "result_review", applied: true } });
    const on = await (await syncRoute.POST(post({}))).json();
    assert.deepEqual(on.pending, [v22Entry("a"), closeEntry(QUESTION), reviewEntry], "after the v22 and card close ones");
    assert.equal(on.auto_applied, "result_review");
  } finally { delete process.env.TOMVERSE_AMUX_V22_RESULT_REVIEW_DM; }
});

test("a T2 draft's advice card rides the tick last, filed only while its switch is on", async () => {
  const t2Entry = { question_id: IDEA, worker: "engineering-t2-review" };
  delete process.env.TOMVERSE_ENGINEERING_AGENT_T2_DM_REVIEW;
  reset({ t2Pending: [t2Entry], t2Closing: [{ questionId: IDEA, cardId: "T2-1" }] });
  const off = await (await syncRoute.POST(post({}))).json();
  assert.deepEqual(off.pending, [], "no new advice card while the switch is off");
  assert.deepEqual(off.closing, [{ question_id: IDEA, card_id: "T2-1" }], "its cards still close");
  assert.ok(world.boundaries.includes("engineeringAgentT2DmReviewRead"));
  process.env.TOMVERSE_ENGINEERING_AGENT_T2_DM_REVIEW = "enabled";
  try {
    const reviewEntry = { question_id: OTHER, worker: "amux-result-review" };
    process.env.TOMVERSE_AMUX_V22_RESULT_REVIEW_DM = "enabled";
    reset({ v22Pending: [v22Entry("a")], reviewPending: [reviewEntry], t2Pending: [t2Entry] });
    const on = await (await syncRoute.POST(post({}))).json();
    assert.deepEqual(on.pending, [v22Entry("a"), reviewEntry, t2Entry], "after every app-answered question");
    assert.equal(world.t2Recorded, null, "nothing to record when every card could be written");

    reset({ t2Pending: [], t2Unfilable: [IDEA] });
    const unfilable = await (await syncRoute.POST(post({}))).json();
    assert.deepEqual(unfilable.pending, []);
    assert.ok(world.boundaries.includes("engineeringAgentT2DmReviewUnfilable"));
    assert.deepEqual(world.t2Recorded, { workItemIds: [IDEA], now: new Date("2026-11-05T00:00:00.000Z") },
      "a draft no card fits is recorded once, so it never holds back the drafts behind it");
  } finally {
    delete process.env.TOMVERSE_ENGINEERING_AGENT_T2_DM_REVIEW;
    delete process.env.TOMVERSE_AMUX_V22_RESULT_REVIEW_DM;
  }
});

test("an owner queue settlement rides the tick before the T2 drafts, filed only while its switch is on", async () => {
  const SETTLEMENT = "44444444-5555-8666-8777-888888888888";
  const settlementEntry = { question_id: SETTLEMENT, worker: "amux-owner-settlement" };
  const t2Entry = { question_id: IDEA, worker: "engineering-t2-review" };
  delete process.env.TOMVERSE_AMUX_DM_OWNER_SETTLEMENT;
  reset({ settlementPending: [settlementEntry], settlementClosing: [{ questionId: SETTLEMENT, cardId: "OS-1" }] });
  const off = await (await syncRoute.POST(post({}))).json();
  assert.equal(world.settlementEnabled, false, "nothing is filed while the switch is off");
  assert.deepEqual(off.pending, []);
  assert.deepEqual(off.closing, [{ question_id: SETTLEMENT, card_id: "OS-1" }], "its cards still close");
  assert.ok(world.boundaries.includes("decisionMakerOwnerSettlementSync"));
  // Owner decision 2026-11-14: with the switch off, the one the owner asked for is still filed.
  reset({ settlementPending: [settlementEntry], settlementRequested: [settlementEntry] });
  assert.deepEqual((await (await syncRoute.POST(post({}))).json()).pending, [settlementEntry]);
  process.env.TOMVERSE_AMUX_DM_OWNER_SETTLEMENT = "enabled";
  process.env.TOMVERSE_ENGINEERING_AGENT_T2_DM_REVIEW = "enabled";
  try {
    reset({ v22Pending: [v22Entry("a")], settlementPending: [settlementEntry], t2Pending: [t2Entry] });
    const on = await (await syncRoute.POST(post({}))).json();
    assert.equal(world.settlementEnabled, true);
    assert.deepEqual(on.pending, [v22Entry("a"), settlementEntry, t2Entry], "after the app-answered ones, before the advice");
  } finally {
    delete process.env.TOMVERSE_AMUX_DM_OWNER_SETTLEMENT;
    delete process.env.TOMVERSE_ENGINEERING_AGENT_T2_DM_REVIEW;
  }
});

test("a fault in opening a question costs nothing of the v22 path", async () => {
  reset({ openError: new Error("database busy"), v22Pending: [v22Entry("a")] });
  const warn = mock.method(console, "warn", () => undefined);
  const response = await syncRoute.POST(post({}));
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).pending, [v22Entry("a")]);
  assert.equal(warn.mock.callCount(), 1);
  assert.ok(!String(warn.mock.calls[0].arguments[0]).includes("database busy"), "the error's text stays out of the log");
  warn.mock.restore();
});

test("the routes stay closed behind the token and the routing switch", async () => {
  reset({ authorized: false });
  assert.equal((await syncRoute.POST(post({}))).status, 401);
  assert.deepEqual(world.calls, []);
  reset({ routing: undefined });
  const closed = await syncRoute.POST(post({}));
  assert.equal(closed.status, 409);
  assert.deepEqual(await closed.json(), { synced: false, reason: "dm_routing_disabled" });
  assert.deepEqual(world.calls, [], "nothing runs while routing is off");
  reset({ routing: undefined });
  assert.equal((await cardRoute.POST(post({ question_id: QUESTION, card_id: "CC-1" }))).status, 409);
  assert.equal((await closedRoute.POST(post({ question_id: QUESTION, card_id: "CC-1" }))).status, 409);
});

test("the card and closed routes record through the dispatch that tries both tables", async () => {
  reset();
  const named = await cardRoute.POST(post({ question_id: QUESTION, card_id: "CC-1" }));
  assert.equal(named.status, 200);
  assert.deepEqual(world.recordedInput, { questionId: QUESTION, cardId: "CC-1" });
  assert.deepEqual(world.boundaries, ["decisionMakerV22QuestionWrite"]);
  reset();
  const closed = await closedRoute.POST(post({ question_id: QUESTION, card_id: "CC-1" }));
  assert.equal(closed.status, 200);
  assert.deepEqual(world.recordedInput, { questionId: QUESTION, cardId: "CC-1",
    now: new Date("2026-11-05T00:00:00.000Z") });
});

const read = (ideaId = IDEA) => ownerRoute.GET(new Request(
  `https://tomverse.test/api/admin/amux/ideas/card-close?${new URLSearchParams({ ideaId })}`));
const answer = (body: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  ownerRoute.POST(new Request("https://tomverse.test/api/admin/amux/ideas/card-close", { method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ ideaId: IDEA, questionId: QUESTION, decision: "close", reason: "No longer wanted.",
      ownerConfirmed: true, ...body }) }));

test("the owner's read shows the idea's open question to the owner alone", async () => {
  reset({ question: { questionId: QUESTION, reasonCode: "blocked_task", cards: [], handedOff: false,
    createdAt: "2026-11-05T00:00:00.000Z" } });
  const shown = await read();
  assert.equal(shown.status, 200);
  assert.equal((await shown.json()).question.questionId, QUESTION);
  assert.deepEqual(world.ownerInput, { ideaId: IDEA, actorUserId: "owner-1" });
  assert.match(shown.headers.get("cache-control") ?? "", /no-store/);
  reset();
  assert.deepEqual(await (await read()).json(), { question: null, direct: null });
  reset({ direct: { reasonCode: "blocked_task", cards: [] } });
  assert.deepEqual(await (await read()).json(), { question: null,
    direct: { reasonCode: "blocked_task", cards: [] } }, "with none open, what a direct close would close");
  reset({ admin: false });
  assert.equal((await read()).status, 404);
  reset({ role: "ops" });
  assert.equal((await read()).status, 403);
  reset({ session: null });
  assert.equal((await read()).status, 404);
  reset();
  assert.equal((await read("x")).status, 400);
});

test("the owner's answer needs the owner, the origin, recent authentication and the exact shape", async () => {
  reset();
  const closed = await answer();
  assert.equal(closed.status, 200);
  assert.deepEqual(await closed.json(), { outcome: "closed", closedCards: 2, auditId: "a", retryWrite: false });
  const input = world.ownerInput as Record<string, unknown>;
  assert.equal(input.ideaId, IDEA);
  assert.equal(input.questionId, QUESTION);
  assert.equal(input.decision, "close");
  assert.equal(input.reason, "No longer wanted.");

  for (const [changes, status] of [[{ admin: false }, 404], [{ session: null }, 404], [{ role: "ops" }, 403],
    [{ originValid: false }, 403], [{ reauthRequired: true }, 428]] as const) {
    reset(changes);
    assert.equal((await answer()).status, status, JSON.stringify(changes));
    assert.equal(world.ownerInput, null, "the service is not reached");
  }
  reset();
  assert.equal((await answer({}, { "content-type": "text/plain" })).status, 415);
  for (const bad of [{ decision: "maybe" }, { ownerConfirmed: false }, { extra: 1 }, { questionId: "x" }]) {
    reset();
    assert.notEqual((await answer(bad)).status, 200, JSON.stringify(bad));
    assert.equal(world.ownerInput, null);
  }
});

test("what the service says reaches the panel, and an unknown failure is never a retry", async () => {
  for (const outcome of ["kept", "cancelled", "not_open", "not_found"]) {
    reset({ ownerResult: { outcome } });
    const response = await answer();
    assert.equal(response.status, 200);
    assert.equal((await response.json()).outcome, outcome);
  }
  for (const [code, status] of [["forbidden", 403], ["invalid", 400], ["integrity_unavailable", 503], ["busy", 409]] as const) {
    reset({ ownerError: new FakeOwnerError(code) });
    const response = await answer();
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), { error: code, retryWrite: false });
  }
  reset({ ownerError: new Error("connection dropped") });
  const unknown = await answer();
  assert.equal(unknown.status, 503);
  assert.deepEqual(await unknown.json(), { error: "outcome_unknown", retryWrite: false });
});

const closeDirectly = (body: Record<string, unknown> = {}) =>
  ownerRoute.POST(new Request("https://tomverse.test/api/admin/amux/ideas/card-close", { method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ideaId: IDEA, direct: true, cardIds: ["card-a", "card-b"], decision: "close",
      reason: "No longer wanted.", ownerConfirmed: true, ...body }) }));

test("the owner's direct close takes the same gates, closes only, and names no question", async () => {
  reset();
  const closed = await closeDirectly();
  assert.equal(closed.status, 200);
  assert.deepEqual(await closed.json(), { outcome: "closed", closedCards: 2, auditId: "a", retryWrite: false });
  const input = world.directInput as Record<string, unknown>;
  assert.equal(input.ideaId, IDEA);
  assert.equal(input.reason, "No longer wanted.");
  assert.deepEqual(input.cardIds, ["card-a", "card-b"], "the cards the page showed");
  assert.equal("questionId" in input, false);
  assert.equal(world.ownerInput, null, "the answer path is not taken");

  reset({ ownerResult: { outcome: "not_closable" } });
  assert.equal((await (await closeDirectly()).json()).outcome, "not_closable");
  for (const [changes, status] of [[{ admin: false }, 404], [{ role: "ops" }, 403],
    [{ originValid: false }, 403], [{ reauthRequired: true }, 428]] as const) {
    reset(changes);
    assert.equal((await closeDirectly()).status, status, JSON.stringify(changes));
    assert.equal(world.directInput, null, "the service is not reached");
  }
  for (const bad of [{ decision: "keep" }, { ownerConfirmed: false }, { questionId: QUESTION }, { direct: false },
    { cardIds: [] }, { cardIds: undefined }, { cardIds: ["a b"] }]) {
    reset();
    assert.notEqual((await closeDirectly(bad)).status, 200, JSON.stringify(bad));
    assert.equal(world.directInput, null, JSON.stringify(bad));
    assert.equal(world.ownerInput, null, JSON.stringify(bad));
  }
  reset({ ownerError: new FakeOwnerError("busy") });
  assert.equal((await closeDirectly()).status, 409);
});

test("the sync records the relay's call after the token and before the routing switch", async () => {
  reset({ authorized: false });
  await syncRoute.POST(post({}));
  assert.equal(world.heartbeats, 0, "an unauthorised caller is not the relay");
  reset({ routing: undefined });
  assert.equal((await syncRoute.POST(post({}))).status, 409);
  assert.equal(world.heartbeats, 1, "a relay calling while routing is off is still calling");
  reset();
  assert.equal((await syncRoute.POST(post({}))).status, 200);
  assert.equal(world.heartbeats, 1);
});
