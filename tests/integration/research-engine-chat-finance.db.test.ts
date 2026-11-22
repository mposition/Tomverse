import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { prisma } from "@/lib/prisma";
import { reconcileExpiredChatCreditReservations } from "@/lib/chatSecurity";
import { setResearchFundingAdapter } from "@/lib/researchEngineFunding";
import { createResearchRun, readResearchRunDto } from "@/lib/researchEngineService";
import { drainResearchWork, processOneResearchWorkItem } from "@/lib/researchEngineWorker";
import { readResearchRunMoney, RESEARCH_SEGMENT_RESERVING_STALE_MS, claimResearchFundingRoom } from "@/lib/researchEngineStore";
import { recoverResearchEngine } from "@/lib/researchEngineRecovery";
import { createFakeModel, createFakeWeb, createUser, defaultResponse, fakeRequest, installFakes, users } from "./researchEngineHarness";

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
