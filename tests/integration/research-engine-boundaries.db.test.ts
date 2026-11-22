import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { prisma } from "@/lib/prisma";
import {
  amendResearchScope, cancelResearchRun, createResearchRun, deleteResearchRun, finishResearchNow, readResearchRunDto, requestResearchRevision,
} from "@/lib/researchEngineService";
import { drainResearchWork, processOneResearchWorkItem } from "@/lib/researchEngineWorker";
import {
  beginResearchDispatch, claimNextResearchWorkItem, claimResearchFundingRoom, readResearchRunMoney, RESEARCH_ITEM_LEASE_MS, ResearchFundingRoomError,
} from "@/lib/researchEngineStore";
import { recoverResearchEngine, drainResearchEvidenceCleanup } from "@/lib/researchEngineRecovery";
import { exportResearchReport, readResearchEvidence, readResearchReport, researchShareContent } from "@/lib/researchEngineReads";
import { settlePendingResearchPreviewRuns } from "@/lib/researchPreviewRecovery";
import { createFakeFunding, createFakeModel, createFakeWeb, createUser, defaultResponse, fakeRequest, installFakes, users } from "./researchEngineHarness";

// The test database is dedicated; v2 rows left by an interrupted earlier run would be claimed here.
before(async () => { await prisma.researchPreviewRun.deleteMany({ where: { engineVersion: 2 } }); });

after(async () => {
  await prisma.user.deleteMany({ where: { id: { in: users } } });
  await prisma.$disconnect();
});

const SECRET = "ZEBRA-SECRET-91 private salary figure of 123456";
const brief = (question: string) => ({ question, deliverable: "report" as const, searchLanguages: [], regions: [],
  includeDomains: [], excludeDomains: [], constraints: [] });
const create = (userId: string, overrides: Record<string, unknown> = {}) => createResearchRun({ request: fakeRequest(), userId, payload: {
  userMessageId: randomUUID(), assistantMessageId: randomUUID(), brief: brief("What do public sources say about topic Y?"), sources: [],
  profile: "standard", approvedCredits: 3_000, autoStart: true, ...overrides,
} as never }).then((result) => result.run);
const memory = (userId: string, statement = SECRET) => prisma.memoryItem.create({ data: { userId, kind: "project", statement, status: "active", confidence: 0.9 } });
const rejects = async (promise: Promise<unknown>, code: string) => {
  await assert.rejects(promise, (error: { code?: string }) => { assert.equal(error.code, code); return true; });
};

test("a user cannot select or read another user's sources, runs, evidence or exports", async () => {
  installFakes();
  createFakeWeb();
  const owner = await createUser("idor-owner");
  const intruder = await createUser("idor-intruder");
  const item = await memory(owner.id);
  const conversation = await prisma.conversation.create({ data: { userId: owner.id, title: "Owner", kind: "chat", productKey: "chat", selectionMode: "manual", selectedModels: "[]" } });
  await rejects(create(intruder.id, { sources: [{ type: "memory", memoryItemId: item.id }] }), "RESEARCH_SOURCE_UNAVAILABLE");
  await rejects(create(intruder.id, { sources: [{ type: "conversation", conversationId: conversation.id }] }), "RESEARCH_SOURCE_UNAVAILABLE");
  await rejects(create(intruder.id, { conversationId: conversation.id }), "RESEARCH_CONVERSATION_UNAVAILABLE");
  await rejects(create(intruder.id, { sources: [{ type: "url", url: "https://127.0.0.1/admin" }] }), "RESEARCH_URL_UNSUPPORTED");
  const run = await create(owner.id, { sources: [{ type: "memory", memoryItemId: item.id }] });
  await drainResearchWork("idor", 4);
  await rejects(readResearchRunDto(intruder.id, run.id), "RESEARCH_RUN_NOT_FOUND");
  await rejects(readResearchReport({ userId: intruder.id, runId: run.id }), "RESEARCH_RUN_NOT_FOUND");
  await rejects(exportResearchReport({ userId: intruder.id, runId: run.id, format: "md" }), "RESEARCH_RUN_NOT_FOUND");
  const chunk = await prisma.researchEvidenceChunk.findFirstOrThrow({ where: { runId: run.id } });
  await rejects(readResearchEvidence({ userId: intruder.id, runId: run.id, chunkId: chunk.id }), "RESEARCH_RUN_NOT_FOUND");
});

test("private material never reaches web search or a search-capable role, and a private report shares only its public redaction", async () => {
  const fakes = installFakes();
  const web = createFakeWeb();
  const user = await createUser("leak");
  const item = await memory(user.id);
  const run = await create(user.id, { sources: [{ type: "memory", memoryItemId: item.id }] });
  await drainResearchWork("leak", 4);
  const state = await readResearchRunDto(user.id, run.id);
  assert.equal(state.status, "completed");
  assert.equal(state.progress.privateSources, 1);
  assert.ok(web.searches.length > 0);
  assert.ok(web.searches.every((query) => !query.includes("ZEBRA")), "no private text in any search query");
  for (const call of fakes.model.calls) {
    if (["submit_research_plan", "submit_research_turn", "submit_research_coverage"].includes(call.tool)) assert.ok(!call.text.includes("ZEBRA"), `${call.tool} saw private text`);
  }
  assert.ok(fakes.model.calls.some((call) => call.tool === "submit_research_private_analysis" && call.text.includes("ZEBRA")), "the analyst did see it");
  const report = await readResearchReport({ userId: user.id, runId: run.id });
  assert.equal(report.containsPrivate, true);
  assert.deepEqual(await researchShareContent(run.id), { ok: false, code: "RESEARCH_SHARE_PRIVATE" });
  await requestResearchRevision({ request: fakeRequest(), userId: user.id, runId: run.id,
    revision: { expectedReportRevision: state.currentReportRevision, kind: "redact_public", sectionKeys: [] } });
  const shared = await researchShareContent(run.id);
  assert.equal(shared?.ok, true);
  assert.ok(shared?.ok && !shared.content.includes("ZEBRA") && !shared.content.includes("Private note"));
  const publicRevision = await prisma.researchReportRevision.findFirstOrThrow({ where: { runId: run.id, visibility: "public" }, include: { claims: true } });
  assert.ok(publicRevision.claims.every((claim) => !claim.privateDerived));
});

test("a private source revoked after selection is never sent to a model (deleted memory, Memory off, conversation re-locked)", async () => {
  const fakes = installFakes();
  createFakeWeb();
  const user = await createUser("revoke");
  const deleted = await memory(user.id, "Deleted memory content that must not leave");
  const kept = await memory(user.id, "Memory content guarded by the master switch");
  const conversation = await prisma.conversation.create({ data: { userId: user.id, title: "Locked later", kind: "chat", productKey: "chat", selectionMode: "manual", selectedModels: "[]" } });
  await prisma.message.create({ data: { id: randomUUID(), role: "user", content: "Conversation text that must not leave after locking", conversationId: conversation.id } });
  const run = await create(user.id, { sources: [{ type: "memory", memoryItemId: deleted.id }, { type: "conversation", conversationId: conversation.id }], autoStart: true });
  const second = await create(user.id, { sources: [{ type: "memory", memoryItemId: kept.id }] });
  await prisma.memoryItem.delete({ where: { id: deleted.id } });
  await prisma.conversation.update({ where: { id: conversation.id }, data: { password: "hashed-password-placeholder", passwordVersion: { increment: 1 } } });
  await prisma.userMemorySettings.upsert({ where: { userId: user.id }, create: { userId: user.id, masterEnabled: false }, update: { masterEnabled: false } });
  await drainResearchWork("revoke", 4);
  for (const call of fakes.model.calls) {
    assert.ok(!call.text.includes("must not leave"), "revoked private text reached a model");
    assert.ok(!call.text.includes("guarded by the master switch"));
  }
  const revoked = await prisma.researchSource.findMany({ where: { runId: { in: [run.id, second.id] }, visibility: "private" } });
  assert.ok(revoked.every((source) => source.status === "revoked"), JSON.stringify(revoked.map((source) => source.status)));
  assert.equal((await readResearchRunDto(user.id, run.id)).status, "completed", "the public part still produces a report");
});

test("an unknown usage outcome is held and never retried; the same dispatch key is refused", async () => {
  let turns = 0;
  const model = createFakeModel({ respond: (call) => {
    if (call.tool === "submit_research_turn" && turns++ === 0) return { usage: "unknown" };
    return defaultResponse(call, { subquestions: 1, sections: 1, readsPerTurn: 1 });
  } });
  installFakes({ model });
  createFakeWeb();
  const user = await createUser("unknown");
  const run = await create(user.id);
  await drainResearchWork("unknown", 2);
  const attention = await prisma.researchWorkItem.findFirst({ where: { runId: run.id, status: "attention" } })
    ?? assert.fail(JSON.stringify(await prisma.researchWorkItem.findMany({ where: { runId: run.id }, select: { kind: true, status: true, errorCode: true } })));
  const generation = await prisma.researchPreviewGeneration.findFirstOrThrow({ where: { workItemId: attention.id } });
  assert.equal(generation.status, "outcome_unknown");
  assert.equal(await prisma.researchPreviewGeneration.count({ where: { workItemId: attention.id } }), 1, "no second dispatch for that item");
  const segment = await prisma.researchFundingSegment.findUniqueOrThrow({ where: { id: generation.fundingSegmentId! } });
  assert.ok(["unknown", "settled"].includes(segment.status));
  const state = await readResearchRunDto(user.id, run.id);
  assert.notEqual(state.money.settlement, "settled", "unknown cost is shown as unknown, never as zero");
  await rejects(prisma.$transaction(async () => {
    await prisma.researchWorkItem.update({ where: { id: attention.id }, data: { status: "running", leaseOwner: "probe", leaseEpoch: 99, leaseExpiresAt: new Date(Date.now() + 60_000) } });
    return beginResearchDispatch({ itemId: attention.id, ownerId: "probe", leaseEpoch: 99, runId: run.id }, { kind: "model", dispatchKey: generation.dispatchKey! });
  }), "RESEARCH_DISPATCH_OUTCOME_UNKNOWN");
});

test("concurrent reservations cannot exceed the approved total, and the finalization reserve is kept for synthesis", async () => {
  installFakes();
  const user = await createUser("overcommit");
  const run = await create(user.id, { autoStart: false });
  await prisma.researchPreviewRun.update({ where: { id: run.id }, data: { approvedCredits: 100, finalizationReserveCredits: 30 } });
  const attempts = await Promise.allSettled(Array.from({ length: 12 }, () =>
    claimResearchFundingRoom({ runId: run.id, purpose: "work", credits: 10, modelId: "m", provider: "google", pricingVersion: "p" })));
  assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, 7, "100 approved - 30 reserved = 7 work holds of 10");
  assert.ok(attempts.filter((attempt) => attempt.status === "rejected").every((attempt) => (attempt as PromiseRejectedResult).reason instanceof ResearchFundingRoomError));
  const finalization = await Promise.allSettled(Array.from({ length: 5 }, () =>
    claimResearchFundingRoom({ runId: run.id, purpose: "finalization", credits: 10, modelId: "m", provider: "google", pricingVersion: "p" })));
  assert.equal(finalization.filter((attempt) => attempt.status === "fulfilled").length, 3);
  const money = await readResearchRunMoney(prisma, run.id);
  assert.ok(money.committedCredits <= money.approvedCredits);
});

test("cancellation stops new dispatches; recovery and a late completion cannot both win", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let gated = false;
  const model = createFakeModel({ respond: (call) => defaultResponse(call, { subquestions: 2, sections: 1 }) });
  const fakes = installFakes({ model });
  createFakeWeb();
  const original = model.model.doGenerate.bind(model.model);
  model.model.doGenerate = async (options) => { if (!gated) { gated = true; await gate; } return original(options); };
  const user = await createUser("race");
  const run = await create(user.id);
  const working = processOneResearchWorkItem("race-worker");
  while (!(await prisma.researchPreviewGeneration.count({ where: { runId: run.id, status: "dispatch_started" } }))) await new Promise((resolve) => setTimeout(resolve, 5));
  // The lease expires and recovery classifies the in-flight dispatch as unknown before the worker answers.
  fakes.clock.advance(RESEARCH_ITEM_LEASE_MS + 5_000);
  await recoverResearchEngine();
  await cancelResearchRun({ request: fakeRequest(), userId: user.id, runId: run.id });
  release();
  await working;
  const generations = await prisma.researchPreviewGeneration.findMany({ where: { runId: run.id } });
  assert.equal(generations.length, 1);
  assert.equal(generations[0]!.status, "outcome_unknown", "the late completion did not overwrite recovery's verdict");
  const state = await readResearchRunDto(user.id, run.id);
  assert.equal(state.status, "attention");
  assert.equal(await processOneResearchWorkItem("after-cancel"), false, "nothing is claimable after cancel");
});

test("poison rows are quarantined without blocking healthy recovery (v1 settlement and v2 manifest)", async () => {
  installFakes({ funding: createFakeFunding() });
  const user = await createUser("poison");
  const conversation = await prisma.conversation.create({ data: { userId: user.id, title: "P", kind: "chat", productKey: "chat", selectionMode: "manual", selectedModels: "[]" } });
  const message = await prisma.message.create({ data: { id: randomUUID(), role: "user", content: "q", conversationId: conversation.id } });
  const reservationId = randomUUID();
  await prisma.chatCreditReservation.create({ data: { id: reservationId, userId: user.id, subjectKey: "s", traceId: "t", source: "chat", provider: "google",
    modelId: "gemini-3-1-pro", idempotencyKey: reservationId, reservationPayload: {}, reservedCredits: 5, reservedCostMicroUsd: BigInt(0),
    planReservedCredits: 5, addOnReservedCredits: 0, expiresAt: new Date(Date.now() + 3_600_000) } });
  const v1 = await prisma.researchPreviewRun.create({ data: { userId: user.id, conversationId: conversation.id, sourceUserMessageId: message.id,
    assistantMessageId: randomUUID(), modelId: "gemini-3-1-pro", provider: "google", apiModel: "gemini-3.1-pro-preview", locale: "en",
    currentDate: "2026-11-23", questionDigest: `sha256:${"a".repeat(64)}`, totalOutputTokens: 4096, inputTokenCeiling: 10, searchSurchargeCredits: 0,
    status: "completed", reservationId, settlementUsage: { garbage: true }, completedAt: new Date() } });
  for (let round = 0; round < 3; round++) await settlePendingResearchPreviewRuns();
  const quarantined = await prisma.researchPreviewRun.findUniqueOrThrow({ where: { id: v1.id } });
  assert.ok(quarantined.recoveryQuarantinedAt, "an unreadable v1 settlement stops being selected first");
  const healthy = await create(user.id);
  const poison = await create(user.id, { autoStart: false });
  await prisma.researchPreviewRun.update({ where: { id: poison.id }, data: { status: "queued", inputManifest: { version: 1, broken: true } } });
  const stale = await claimNextResearchWorkItem("dead-worker");
  assert.equal(stale?.runId, healthy.id);
  const clock = (await import("@/lib/researchEngineRuntime"));
  for (let round = 0; round < 3; round++) await recoverResearchEngine();
  void clock;
  const poisoned = await prisma.researchPreviewRun.findUniqueOrThrow({ where: { id: poison.id } });
  assert.ok(poisoned.recoveryQuarantinedAt, "a v2 run that cannot be advanced is quarantined");
  assert.ok(poisoned.recoveryFailureCount >= 3);
});

test("same URL read twice is two evidence versions; a refresh revision re-locates quotes and the old revision keeps its own", async () => {
  const fakes = installFakes({ model: createFakeModel({ respond: (call) => defaultResponse(call, { subquestions: 1, sections: 1, readsPerTurn: 2 }) }) });
  const web = createFakeWeb();
  const user = await createUser("versions");
  const run = await create(user.id);
  await drainResearchWork("versions", 2);
  const before = await readResearchRunDto(user.id, run.id);
  assert.equal(before.status, "completed");
  const firstClaims = await prisma.researchClaim.findMany({ where: { revision: { runId: run.id, revision: before.currentReportRevision } }, orderBy: { claimKey: "asc" } });
  const cited = await prisma.researchSource.findMany({ where: { runId: run.id, versions: { some: { readStatus: "read" } } } });
  for (const source of cited) web.bump(source.canonicalUrl!);
  const callsBefore = fakes.model.calls.length;
  await requestResearchRevision({ request: fakeRequest(), userId: user.id, runId: run.id,
    revision: { expectedReportRevision: before.currentReportRevision, kind: "refresh", sectionKeys: [] } });
  await drainResearchWork("versions-refresh", 2);
  const after = await readResearchRunDto(user.id, run.id);
  assert.ok(after.currentReportRevision > before.currentReportRevision);
  const versions = await prisma.researchSourceVersion.findMany({ where: { sourceId: cited[0]!.id, readStatus: "read" }, orderBy: { version: "asc" } });
  assert.ok(versions.length >= 2, "the refresh stored a new version instead of overwriting");
  assert.notEqual(versions[0]!.contentDigest, versions.at(-1)!.contentDigest);
  const oldClaims = await prisma.researchClaim.findMany({ where: { revision: { runId: run.id, revision: before.currentReportRevision } }, orderBy: { claimKey: "asc" } });
  assert.deepEqual(oldClaims.map((claim) => claim.evidence), firstClaims.map((claim) => claim.evidence), "the old revision still cites what it saw");
  assert.ok(fakes.model.calls.slice(callsBefore).every((call) => call.tool !== "submit_research_turn"), "a refresh does not repeat the research turns");
});

test("a format revision reuses verified claims without new research; scope changes apply only to new work; deletion cleans private objects", async () => {
  const fakes = installFakes({ model: createFakeModel({ respond: (call) => defaultResponse(call, { subquestions: 1, sections: 1 }) }) });
  const web = createFakeWeb();
  const user = await createUser("revise");
  const run = await create(user.id);
  // A scope change mid-run creates new work at a new input revision only.
  await drainResearchWork("revise-a", 1, { maxSlices: 3 });
  const mid = await readResearchRunDto(user.id, run.id);
  if (mid.approvedPlanRevision && !["completed", "finalizing"].includes(mid.status)) {
    await amendResearchScope({ request: fakeRequest(), userId: user.id, runId: run.id,
      amendment: { expectedInputRevision: mid.inputRevision, addQuestions: ["An added question?"], excludeSourceKeys: [], excludeDomains: [] } });
    const added = await prisma.researchWorkItem.findFirst({ where: { runId: run.id, kind: "investigate", inputRevision: mid.inputRevision + 1 } });
    assert.ok(added, "the added question is new work at the new input revision");
  }
  await drainResearchWork("revise-b", 2);
  const done = await readResearchRunDto(user.id, run.id);
  assert.equal(done.status, "completed");
  const searchesBefore = web.searches.length;
  const turnsBefore = fakes.model.calls.filter((call) => call.tool === "submit_research_turn").length;
  await requestResearchRevision({ request: fakeRequest(), userId: user.id, runId: run.id,
    revision: { expectedReportRevision: done.currentReportRevision, kind: "format", sectionKeys: [], instruction: "Make it shorter" } });
  // A retried request with the same content is a readback, not a second revision.
  await requestResearchRevision({ request: fakeRequest(), userId: user.id, runId: run.id,
    revision: { expectedReportRevision: done.currentReportRevision, kind: "format", sectionKeys: [], instruction: "Make it shorter" } });
  await drainResearchWork("revise-c", 2);
  const revised = await readResearchRunDto(user.id, run.id);
  assert.equal(revised.currentReportRevision, done.currentReportRevision + 1);
  assert.equal(web.searches.length, searchesBefore, "formatting did not search");
  assert.equal(fakes.model.calls.filter((call) => call.tool === "submit_research_turn").length, turnsBefore, "formatting did not research");
  const latest = await prisma.researchReportRevision.findFirstOrThrow({ where: { runId: run.id, revision: revised.currentReportRevision } });
  assert.equal(latest.author, "user_edit");
  assert.equal(latest.parentRevision, done.currentReportRevision);
  // Deletion: refused while work is in flight, then evidence objects are queued and drained.
  const keys = (await prisma.researchSourceVersion.findMany({ where: { runId: run.id, objectKey: { not: null } }, select: { objectKey: true } })).map((row) => row.objectKey!);
  assert.ok(keys.length > 0 && keys.every((key) => fakes.store.objects.has(key)));
  await deleteResearchRun({ request: fakeRequest(), userId: user.id, runId: run.id });
  assert.equal(await prisma.researchEvidenceObjectCleanup.count({ where: { objectKey: { in: keys } } }), keys.length);
  await drainResearchEvidenceCleanup();
  assert.ok(keys.every((key) => !fakes.store.objects.has(key)), "private evidence objects are deleted with the run");
  assert.equal(await prisma.researchWorkItem.count({ where: { runId: run.id } }), 0);
});

test("finishing early writes a report from the evidence already gathered without further research", async () => {
  const fakes = installFakes({ model: createFakeModel({ respond: (call) => defaultResponse(call, { subquestions: 3, sections: 1, readsPerTurn: 1 }) }) });
  createFakeWeb();
  const user = await createUser("finish");
  const run = await create(user.id);
  await drainResearchWork("finish-a", 1, { maxSlices: 6 });
  await finishResearchNow({ request: fakeRequest(), userId: user.id, runId: run.id });
  const turnsAt = fakes.model.calls.filter((call) => call.tool === "submit_research_turn").length;
  await drainResearchWork("finish-b", 2);
  const state = await readResearchRunDto(user.id, run.id);
  assert.equal(state.status, "completed");
  assert.ok(fakes.model.calls.filter((call) => call.tool === "submit_research_turn").length <= turnsAt + 2, "only already-running research could finish");
  assert.equal(await prisma.researchWorkItem.count({ where: { runId: run.id, kind: "coordinate" } }), 0, "no further coordination round");
});

test("offer and draft creation never call a model, and a brief far past the Preview's 4,000 characters is accepted whole", async () => {
  const fakes = installFakes();
  const web = createFakeWeb();
  const user = await createUser("no-call");
  const { researchEngineOffer } = await import("@/lib/researchEngineService");
  const offer = await researchEngineOffer(user.id);
  assert.equal(offer.offered, true);
  const question = `${"Detailed research context sentence. ".repeat(600)}Final question?`;
  assert.ok(question.length > 20_000);
  const run = await create(user.id, { brief: brief(question), autoStart: false });
  assert.equal(run.status, "draft");
  assert.equal(fakes.model.calls.length, 0, "no paid call before the user asks for a plan");
  assert.equal(web.searches.length, 0);
  const stored = await prisma.message.findUniqueOrThrow({ where: { id: (await prisma.researchPreviewRun.findUniqueOrThrow({ where: { id: run.id } })).sourceUserMessageId } });
  assert.equal(stored.content, question.trim(), "the brief is not truncated");
});

test("a Project source adapter is used only through the selection, revalidation and load contract", async () => {
  const fakes = installFakes();
  createFakeWeb();
  const { setResearchProjectSourceAdapter } = await import("@/lib/researchEngineSources");
  const user = await createUser("project");
  await rejects(create(user.id, { sources: [{ type: "project", projectId: "proj1" }] }), "RESEARCH_PROJECT_UNAVAILABLE");
  let revoked = false;
  const calls: string[] = [];
  setResearchProjectSourceAdapter({
    available: () => true,
    resolve: async ({ userId, projectId }) => { calls.push("resolve"); return userId === user.id && projectId === "proj1" ? { revision: "r1", label: "Project notes" } : null; },
    revalidate: async ({ revision }) => { calls.push("revalidate"); return !revoked && revision === "r1"; },
    load: async () => { calls.push("load"); return { text: "Project material about tariffs and regional supply chains in detail.", label: "Project notes" }; },
  });
  try {
    const intruder = await createUser("project-intruder");
    await rejects(create(intruder.id, { sources: [{ type: "project", projectId: "proj1" }] }), "RESEARCH_SOURCE_UNAVAILABLE");
    const run = await create(user.id, { sources: [{ type: "project", projectId: "proj1" }] });
    await drainResearchWork("project", 2);
    assert.ok(calls.includes("resolve") && calls.includes("load") && calls.includes("revalidate"));
    assert.ok(fakes.model.calls.some((call) => call.tool === "submit_research_private_analysis" && call.text.includes("Project material")));
    assert.ok(fakes.model.calls.filter((call) => call.tool === "submit_research_turn").every((call) => !call.text.includes("Project material")));
    revoked = true;
    const second = await create(user.id, { sources: [{ type: "project", projectId: "proj1" }] });
    await drainResearchWork("project-revoked", 2);
    const source = await prisma.researchSource.findFirstOrThrow({ where: { runId: second.id, visibility: "private" } });
    assert.equal(source.status, "revoked");
    assert.equal((await readResearchRunDto(user.id, run.id)).status, "completed");
  } finally {
    setResearchProjectSourceAdapter(null);
  }
});

test("a hold bound but never dispatched is not settled as zero while a worker may still use it; recovery releases it under the run lock and a late dispatch is refused", async () => {
  const fakes = installFakes();
  const user = await createUser("orphan");
  const run = await create(user.id, { autoStart: false });
  await prisma.researchWorkItem.create({ data: { runId: run.id, kind: "plan", status: "running", planRevision: 0, inputRevision: 0, idempotencyKey: "probe",
    payload: { kind: "plan" }, leaseOwner: "late-worker", leaseEpoch: 1, leaseExpiresAt: new Date(fakes.clock.now().getTime() + 3_600_000) } });
  const item = await prisma.researchWorkItem.findFirstOrThrow({ where: { runId: run.id, idempotencyKey: "probe" } });
  const segment = await claimResearchFundingRoom({ runId: run.id, purpose: "plan", credits: 10, modelId: "gemini-3-1-pro", provider: "google", pricingVersion: "fake-pricing-v1" });
  const reservation = await fakes.funding.adapter.reserve({ userId: user.id, segmentId: segment.id, model: {} as never,
    estimate: { credits: 10, pricingVersion: "fake-pricing-v1", budget: {} }, searchEnabled: false });
  assert.ok(reservation.ok);
  await prisma.researchFundingSegment.update({ where: { id: segment.id }, data: { status: "reserved", reservationId: reservation.reservationId } });
  const { settleResearchSegmentIfReady } = await import("@/lib/researchEngineFunding");
  assert.equal(await settleResearchSegmentIfReady(segment.id), false, "no intent yet: never settled as an unused hold");
  assert.equal((await prisma.researchFundingSegment.findUniqueOrThrow({ where: { id: segment.id } })).status, "reserved");
  await prisma.researchFundingSegment.update({ where: { id: segment.id }, data: { createdAt: new Date(Date.now() - 10 * 60_000) } });
  fakes.clock.advance(10 * 60_000);
  await recoverResearchEngine();
  assert.equal((await prisma.researchFundingSegment.findUniqueOrThrow({ where: { id: segment.id } })).status, "released");
  await rejects(beginResearchDispatch({ itemId: item.id, ownerId: "late-worker", leaseEpoch: 1, runId: run.id },
    { kind: "model", dispatchKey: "late", fundingSegmentId: segment.id, modelId: "m", provider: "google", apiModel: "a", pricingVersion: "p" }), "RESEARCH_FUNDING_NOT_OPEN");
});

test("a budget-stopped run past its deadline is finished by recovery with the evidence it has", async () => {
  const fakes = installFakes({ model: createFakeModel({ respond: (call) => defaultResponse(call, { subquestions: 3, sections: 1, readsPerTurn: 1 }) }) });
  createFakeWeb();
  const user = await createUser("deadline");
  const run = await create(user.id, { approvedCredits: 120 });
  await drainResearchWork("deadline", 2);
  const waiting = await readResearchRunDto(user.id, run.id);
  assert.equal(waiting.status, "awaiting_input");
  assert.ok(waiting.budgetReached);
  fakes.clock.advance(7 * 60 * 60_000);
  await recoverResearchEngine();
  await drainResearchWork("deadline-final", 2);
  const finished = await readResearchRunDto(user.id, run.id);
  assert.equal(finished.status, "completed", "the deadline finished it instead of waiting forever");
  const money = await readResearchRunMoney(prisma, run.id);
  assert.ok(money.settledCredits <= money.approvedCredits);
});
