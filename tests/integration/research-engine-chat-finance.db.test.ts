import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { prisma } from "@/lib/prisma";
import { reconcileExpiredChatCreditReservations } from "@/lib/chatSecurity";
import { researchFundingAdapter, setResearchFundingAdapter } from "@/lib/researchEngineFunding";
import { createResearchRun, readResearchRunDto } from "@/lib/researchEngineService";
import { drainResearchWork, processOneResearchWorkItem } from "@/lib/researchEngineWorker";
import { bindResearchFundingReservation, readResearchRunMoney, RESEARCH_SEGMENT_RESERVING_STALE_MS, claimResearchFundingRoom } from "@/lib/researchEngineStore";
import { recoverResearchEngine, recoverStaleReservingSegments } from "@/lib/researchEngineRecovery";
import { createFakeModel, createFakeWeb, createUser, defaultResponse, fakeRequest, installFakes, MODEL_ID, modelConfig, users } from "./researchEngineHarness";
import { setResearchModelResolver } from "@/lib/researchEngineModel";

/**
 * Engine v2 against the real Chat credit layer: each paid dispatch is an
 * ordinary ChatCreditReservation, settled by settleChatUsage, and expiry
 * reconciliation never refunds a hold whose dispatch may still be running.
 * Model, search and network stay fake; nothing is sent anywhere.
 */

process.env.WEB_SEARCH_FAKE_BACKEND = "1";
process.env.CHAT_PROVIDER_GOOGLE_COST_MICROUSD_PER_DAY = "1000000000";
process.env.CHAT_PROVIDER_GOOGLE_COST_MICROUSD_PER_MONTH = "1000000000";

before(async () => { await prisma.researchPreviewRun.deleteMany({ where: { engineVersion: 2 } }); });
after(async () => {
  const segments = await prisma.researchFundingSegment.findMany({ where: { run: { userId: { in: users } } }, select: { reservationId: true } });
  const reservationIds = segments.map((segment) => segment.reservationId).filter(Boolean) as string[];
  await prisma.user.deleteMany({ where: { id: { in: users } } });
  await prisma.researchFundingSegment.deleteMany({ where: { reservationId: { in: reservationIds } } });
  await prisma.chatCreditReservation.deleteMany({ where: { id: { in: segments.map((segment) => segment.reservationId).filter(Boolean) as string[] } } });
  await prisma.$disconnect();
});

const brief = (question: string) => ({ question, deliverable: "report" as const, searchLanguages: [], regions: [],
  includeDomains: [], excludeDomains: [], constraints: [] });

test("every paid dispatch is one Chat reservation, settled at or below its hold, and the run total matches the Chat ledger", async () => {
  installFakes({ model: createFakeModel({ respond: (call) => defaultResponse(call, { subquestions: 1, sections: 1, readsPerTurn: 1 }) }) });
  setResearchFundingAdapter(null);
  createFakeWeb();
  const user = await createUser("finance-real");
  const { run } = await createResearchRun({ request: fakeRequest(), userId: user.id, payload: { userMessageId: randomUUID(), assistantMessageId: randomUUID(),
    brief: brief("Finance-backed question"), sources: [], profile: "standard", approvedCredits: 5_000, autoStart: true } });
  await drainResearchWork("finance", 2);
  const final = await readResearchRunDto(user.id, run.id);
  assert.equal(final.status, "completed", final.status);
  const segments = await prisma.researchFundingSegment.findMany({ where: { runId: run.id }, include: { reservation: true } });
  assert.ok(segments.length >= 5);
  for (const segment of segments.filter((entry) => entry.status === "settled")) {
    assert.ok(segment.reservation, "a settled segment names a real Chat reservation");
    assert.notEqual(segment.reservation!.status, "reserved");
    assert.equal(segment.reservation!.traceId, segment.id);
    assert.ok((segment.settledCredits ?? 0) <= segment.reservedCredits);
    assert.equal(segment.reservation!.settledCredits, segment.settledCredits);
  }
  // A search-enabled dispatch that served no search gets its reserved surcharge back.
  const noSearch = segments.filter((segment) => segment.status === "settled" && segment.searchSurchargeCredits > 0 &&
    (segment.settlementUsage as { searchExecuted?: boolean } | null)?.searchExecuted === false);
  assert.ok(noSearch.length > 0, "the fixture has a researcher turn without searches");
  for (const segment of noSearch) assert.ok((segment.settledCredits ?? 0) <= segment.reservedCredits - segment.searchSurchargeCredits, "surcharge refunded");
  const money = await readResearchRunMoney(prisma, run.id);
  assert.equal(money.reservedCredits, 0);
  assert.equal(money.settledCredits, segments.reduce((sum, segment) => sum + (segment.settledCredits ?? 0), 0));
  assert.ok(money.settledCredits <= money.approvedCredits);
  const modelGenerations = await prisma.researchPreviewGeneration.findMany({ where: { runId: run.id, kind: "model" } });
  assert.ok(modelGenerations.every((generation) => generation.pricingVersion && generation.modelId && generation.fundingSegmentId),
    "each dispatch pins its own model and price identity");
});

test("expiry reconciliation keeps a hold whose dispatch may still be running; the worker then settles its known usage", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const model = createFakeModel({ respond: (call) => defaultResponse(call, { subquestions: 1, sections: 1 }) });
  const fakes = installFakes({ model });
  setResearchFundingAdapter(null);
  createFakeWeb();
  const original = model.model.doGenerate.bind(model.model);
  let first = true;
  model.model.doGenerate = async (options) => { if (first) { first = false; await gate; } return original(options); };
  const user = await createUser("finance-expiry");
  const { run } = await createResearchRun({ request: fakeRequest(), userId: user.id, payload: { userMessageId: randomUUID(), assistantMessageId: randomUUID(),
    brief: brief("Expiry question"), sources: [], profile: "standard", approvedCredits: 5_000, autoStart: true } });
  const working = processOneResearchWorkItem("expiry-worker");
  while (!(await prisma.researchPreviewGeneration.count({ where: { runId: run.id, status: "dispatch_started" } }))) await new Promise((resolve) => setTimeout(resolve, 5));
  const segment = await prisma.researchFundingSegment.findFirstOrThrow({ where: { runId: run.id, status: "reserved" } });
  await prisma.chatCreditReservation.update({ where: { id: segment.reservationId! }, data: { expiresAt: new Date(Date.now() - 60 * 60_000) } });
  await reconcileExpiredChatCreditReservations().catch(() => undefined);
  const held = await prisma.chatCreditReservation.findUniqueOrThrow({ where: { id: segment.reservationId! } });
  assert.equal(held.status, "reserved", "an expired hold with a possibly-running dispatch is not refunded");
  release();
  await working;
  const after = await prisma.researchFundingSegment.findUniqueOrThrow({ where: { id: segment.id } });
  assert.equal(after.status, "settled", "the worker's own known usage settled it");
  void fakes;
});

test("a crash between claiming room and binding the reservation neither leaks a hold nor double counts", async () => {
  const fakes = installFakes();
  setResearchFundingAdapter(null);
  const user = await createUser("finance-crash");
  const { run } = await createResearchRun({ request: fakeRequest(), userId: user.id, payload: { userMessageId: randomUUID(), assistantMessageId: randomUUID(),
    brief: brief("Crash question"), sources: [], profile: "standard", approvedCredits: 500, autoStart: false } });
  const segment = await claimResearchFundingRoom({ runId: run.id, purpose: "work", credits: 20, modelId: "gemini-3-1-pro", provider: "google", pricingVersion: "p" });
  const before = await readResearchRunMoney(prisma, run.id);
  assert.equal(before.reservedCredits, 20, "room is counted while the reservation request is in flight");
  fakes.clock.advance(RESEARCH_SEGMENT_RESERVING_STALE_MS + 1_000);
  await prisma.researchFundingSegment.update({ where: { id: segment.id }, data: { createdAt: new Date(Date.now() - RESEARCH_SEGMENT_RESERVING_STALE_MS - 1_000) } });
  await recoverResearchEngine();
  const recovered = await prisma.researchFundingSegment.findUniqueOrThrow({ where: { id: segment.id } });
  assert.equal(recovered.status, "released");
  assert.equal((await readResearchRunMoney(prisma, run.id)).reservedCredits, 0);
});

/**
 * A worker slower than the stale cutoff may bind its reservation while recovery
 * is looking at the same "reserving" segment. The lookup is intercepted to land
 * the worker's bind in exactly that window.
 */
async function raceWorkerBindDuringRecovery(label: string, reserveBeforeRecovery: boolean) {
  const fakes = installFakes();
  const user = await createUser(label);
  const { run } = await createResearchRun({ request: fakeRequest(), userId: user.id, payload: { userMessageId: randomUUID(), assistantMessageId: randomUUID(),
    brief: brief("Slow worker question"), sources: [], profile: "standard", approvedCredits: 500, autoStart: false } });
  const segment = await claimResearchFundingRoom({ runId: run.id, purpose: "work", credits: 20, modelId: "gemini-3-1-pro", provider: "google", pricingVersion: "p" });
  const reserveAsWorker = () => fakes.funding.adapter.reserve({ userId: user.id, segmentId: segment.id, model: {} as never, searchEnabled: false,
    estimate: { credits: 20, pricingVersion: "p", searchSurchargeCredits: 0, budget: {} } as never });
  const early = reserveBeforeRecovery ? await reserveAsWorker() : null;
  fakes.clock.advance(RESEARCH_SEGMENT_RESERVING_STALE_MS + 1_000);
  await prisma.researchFundingSegment.update({ where: { id: segment.id }, data: { createdAt: new Date(Date.now() - RESEARCH_SEGMENT_RESERVING_STALE_MS - 1_000) } });
  const delegate = prisma.chatCreditReservation as unknown as { findFirst: (args: unknown) => Promise<unknown> };
  const original = delegate.findFirst;
  let reservationId: string | undefined;
  delegate.findFirst = async (args) => {
    const seen = await original.call(prisma.chatCreditReservation, args);
    if ((args as { where?: { traceId?: string } }).where?.traceId === segment.id && !reservationId) {
      const reservation = early ?? await reserveAsWorker();
      assert.ok(reservation.ok);
      reservationId = reservation.reservationId;
      await bindResearchFundingReservation(segment.id, reservation.reservationId, reservation.reservedCredits);
    }
    return seen;
  };
  try {
    await recoverStaleReservingSegments();
  } finally {
    delegate.findFirst = original;
  }
  const after = await prisma.researchFundingSegment.findUniqueOrThrow({ where: { id: segment.id } });
  assert.equal(after.status, "reserved", "the worker keeps the segment it bound");
  assert.equal(after.reservationId, reservationId);
  assert.equal(fakes.funding.reservations.get(reservationId!)?.status, "reserved", "the worker's hold is not refunded under it");
  assert.equal((await readResearchRunMoney(prisma, run.id)).reservedCredits, 20, "the hold still counts against the approved total");
  const current = await prisma.researchPreviewRun.findUniqueOrThrow({ where: { id: run.id } });
  assert.equal(current.recoveryFailureCount, 0, "losing the race to a live worker is not a recovery failure");
}

test("stale reserving recovery that saw no reservation never releases a segment a worker binds meanwhile", async () => {
  await raceWorkerBindDuringRecovery("finance-race-none", false);
});

test("stale reserving recovery that saw a reservation leaves it to the worker that bound it first", async () => {
  await raceWorkerBindDuringRecovery("finance-race-seen", true);
});

test("a hold that expires between its creation and its bind is refunded only after the segment is fenced, and nothing dispatches on it", async () => {
  installFakes();
  setResearchFundingAdapter(null);
  createFakeWeb();
  const real = await researchFundingAdapter();
  const expired: Array<{ segmentId: string; reservationId: string }> = [];
  setResearchFundingAdapter({ ...real, async reserve(input) {
    const reservation = await real.reserve(input);
    if (reservation.ok && !expired.length) {
      // The worker stalls here past the hold's expiry; reconciliation runs before its bind.
      expired.push({ segmentId: input.segmentId, reservationId: reservation.reservationId });
      await prisma.chatCreditReservation.update({ where: { id: reservation.reservationId }, data: { expiresAt: new Date(Date.now() - 60 * 60_000) } });
      await reconcileExpiredChatCreditReservations();
    }
    return reservation;
  } });
  try {
    const user = await createUser("finance-expiry-unbound");
    const { run } = await createResearchRun({ request: fakeRequest(), userId: user.id, payload: { userMessageId: randomUUID(), assistantMessageId: randomUUID(),
      brief: brief("Unbound expiry question"), sources: [], profile: "standard", approvedCredits: 5_000, autoStart: true } });
    await processOneResearchWorkItem("unbound-expiry-worker");
    assert.equal(expired.length, 1);
    const segment = await prisma.researchFundingSegment.findUniqueOrThrow({ where: { id: expired[0]!.segmentId }, include: { generations: true } });
    assert.equal(segment.status, "released", "expiry fenced the unbound segment");
    assert.equal(segment.reservationId, null, "the refunded hold was never bound");
    assert.equal(segment.generations.length, 0, "nothing was dispatched on a refunded hold");
    const reservation = await prisma.chatCreditReservation.findUniqueOrThrow({ where: { id: expired[0]!.reservationId } });
    assert.notEqual(reservation.status, "reserved");
    assert.equal((await readResearchRunMoney(prisma, run.id)).reservedCredits, 0);
  } finally {
    setResearchFundingAdapter(null);
  }
});

test("a hold that is no longer reserved cannot be bound to its segment", async () => {
  const fakes = installFakes();
  const user = await createUser("finance-bind-settled");
  const { run } = await createResearchRun({ request: fakeRequest(), userId: user.id, payload: { userMessageId: randomUUID(), assistantMessageId: randomUUID(),
    brief: brief("Bind question"), sources: [], profile: "standard", approvedCredits: 500, autoStart: false } });
  const segment = await claimResearchFundingRoom({ runId: run.id, purpose: "work", credits: 20, modelId: "gemini-3-1-pro", provider: "google", pricingVersion: "p" });
  const reservation = await fakes.funding.adapter.reserve({ userId: user.id, segmentId: segment.id, model: {} as never, searchEnabled: false,
    estimate: { credits: 20, pricingVersion: "p", searchSurchargeCredits: 0, budget: {} } as never });
  assert.ok(reservation.ok);
  await prisma.chatCreditReservation.update({ where: { id: reservation.reservationId }, data: { status: "released" } });
  await assert.rejects(bindResearchFundingReservation(segment.id, reservation.reservationId, reservation.reservedCredits), { code: "RESEARCH_FUNDING_BIND_CONFLICT" });
  assert.equal((await prisma.researchFundingSegment.findUniqueOrThrow({ where: { id: segment.id } })).status, "reserving");
});

test("a request whose input fits the context window but whose output cap does not is refused before dispatch", async () => {
  // Earlier tests leave queued items behind; this worker must pick this run's plan.
  await prisma.researchPreviewRun.deleteMany({ where: { engineVersion: 2 } });
  const fakes = installFakes();
  // The plan asks for 6,000 output tokens; a 6,000-token window holds its input but not input plus output.
  setResearchModelResolver(async (id) => (id === MODEL_ID ? { ...modelConfig, contextWindowTokens: 6_000 } : null));
  const user = await createUser("finance-context-window");
  const { run } = await createResearchRun({ request: fakeRequest(), userId: user.id, payload: { userMessageId: randomUUID(), assistantMessageId: randomUUID(),
    brief: brief("Context window question"), sources: [], profile: "standard", approvedCredits: 5_000, autoStart: true } });
  await processOneResearchWorkItem("context-window-worker");
  assert.equal(fakes.model.calls.length, 0, "nothing was sent to the provider");
  const generations = await prisma.researchPreviewGeneration.findMany({ where: { runId: run.id, kind: "model" } });
  assert.ok(generations.length > 0 && generations.every((generation) => generation.status === "dispatch_refused"));
  const money = await readResearchRunMoney(prisma, run.id);
  assert.equal(money.reservedCredits, 0);
  assert.equal(money.settledCredits, 0, "a refused request costs nothing");
});
