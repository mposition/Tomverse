import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { prisma } from "@/lib/prisma";
import {
  amendResearchScope, approveResearchPlan, cancelResearchRun, createResearchRun, deleteResearchRun, finishResearchNow, pauseResearchRun, readResearchRunDto,
  requestResearchRevision, resumeResearchRun,
} from "@/lib/researchEngineService";
import { drainResearchWork, processOneResearchWorkItem, revokePrivateSource } from "@/lib/researchEngineWorker";
import {
  beginResearchDispatch, claimNextResearchWorkItem, claimResearchFundingRoom, readResearchRunMoney, RESEARCH_ITEM_LEASE_MS, ResearchFundingRoomError,
} from "@/lib/researchEngineStore";
import { recoverResearchEngine, drainResearchEvidenceCleanup } from "@/lib/researchEngineRecovery";
import { exportResearchReport, listResearchSources, readResearchEvidence, readResearchReport, researchShareContent } from "@/lib/researchEngineReads";
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
  const run = await create(user.id, { autoStart: false, requestPlan: false });
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
  const poison = await create(user.id, { autoStart: false, requestPlan: false });
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
  assert.notEqual(versions[0]!.objectKey, versions.at(-1)!.objectKey, "each version has its own stored object");
  // The old version's span still reads its own text, not the refreshed page.
  const oldChunk = await prisma.researchEvidenceChunk.findFirstOrThrow({ where: { versionId: versions[0]!.id }, orderBy: { chunkIndex: "asc" } });
  const oldText = fakes.store.objects.get(versions[0]!.objectKey!)!;
  assert.equal((await readResearchEvidence({ userId: user.id, runId: run.id, chunkId: oldChunk.id })).text, oldText.slice(oldChunk.charStart, oldChunk.charEnd));
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
  const run = await create(user.id, { brief: brief(question), autoStart: false, requestPlan: false });
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
  const run = await create(user.id, { autoStart: false, requestPlan: false });
  await prisma.researchWorkItem.create({ data: { runId: run.id, kind: "plan", status: "running", planRevision: 0, inputRevision: 0, idempotencyKey: "probe",
    payload: { kind: "plan" }, leaseOwner: "late-worker", leaseEpoch: 1, leaseExpiresAt: new Date(fakes.clock.now().getTime() + 3_600_000) } });
  const item = await prisma.researchWorkItem.findFirstOrThrow({ where: { runId: run.id, idempotencyKey: "probe" } });
  const segment = await claimResearchFundingRoom({ runId: run.id, purpose: "plan", credits: 10, modelId: "gemini-3-1-pro", provider: "google", pricingVersion: "fake-pricing-v1" });
  const reservation = await fakes.funding.adapter.reserve({ userId: user.id, segmentId: segment.id, model: {} as never,
    estimate: { credits: 10, pricingVersion: "fake-pricing-v1", searchSurchargeCredits: 0, budget: {} }, searchEnabled: false });
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

test("making a plan starts planning at once, and the run deadline counts research time only, not plan review or a pause", async () => {
  const fakes = installFakes();
  createFakeWeb();
  const user = await createUser("deadline-window");
  const run = await create(user.id, { autoStart: false });
  assert.equal(run.status, "planning", "the create request that says 'make a plan' queues the plan without a second request");
  await drainResearchWork("deadline-window-plan", 2);
  assert.equal((await readResearchRunDto(user.id, run.id)).status, "awaiting_input");
  const planned = await prisma.researchPreviewRun.findUniqueOrThrow({ where: { id: run.id } });
  assert.equal(planned.runDeadlineAt, null, "no research deadline runs while the plan waits for review");
  // The standard profile allows 120 minutes of research; the user reviews the plan for three hours.
  fakes.clock.advance(3 * 60 * 60_000);
  await approveResearchPlan({ request: fakeRequest(), userId: user.id, runId: run.id, planRevision: planned.planRevision });
  const started = await prisma.researchPreviewRun.findUniqueOrThrow({ where: { id: run.id } });
  assert.equal(started.runDeadlineAt?.getTime(), fakes.clock.now().getTime() + 120 * 60_000);
  await pauseResearchRun({ request: fakeRequest(), userId: user.id, runId: run.id });
  assert.equal((await readResearchRunDto(user.id, run.id)).status, "paused");
  fakes.clock.advance(90 * 60_000);
  await resumeResearchRun({ request: fakeRequest(), userId: user.id, runId: run.id });
  const resumed = await prisma.researchPreviewRun.findUniqueOrThrow({ where: { id: run.id } });
  assert.equal(resumed.runDeadlineAt?.getTime(), started.runDeadlineAt!.getTime() + 90 * 60_000, "paused time is added back");
  await drainResearchWork("deadline-window-run", 4);
  assert.equal((await readResearchRunDto(user.id, run.id)).status, "completed");
  assert.equal(await prisma.researchWorkItem.count({ where: { runId: run.id, errorCode: "RESEARCH_RUN_DEADLINE" } }), 0,
    "no research was cut short by time spent waiting");
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

test("a run with an unsettled unknown dispatch cannot be deleted; synthesis re-checks private sources before sending private-derived sections", async () => {
  let turns = 0;
  const model = createFakeModel({ respond: (call) => {
    if (call.tool === "submit_research_turn" && turns++ === 0) return { usage: "unknown" };
    return defaultResponse(call, { subquestions: 1, sections: 1, readsPerTurn: 1 });
  } });
  installFakes({ model });
  createFakeWeb();
  const user = await createUser("unknown-delete");
  const run = await create(user.id);
  await drainResearchWork("unknown-delete", 2);
  assert.ok(await prisma.researchFundingSegment.count({ where: { runId: run.id, status: "unknown" } }));
  const state = await readResearchRunDto(user.id, run.id);
  assert.equal(state.actions.canDelete, false);
  await rejects(deleteResearchRun({ request: fakeRequest(), userId: user.id, runId: run.id }), "RESEARCH_RUN_ACTIVE");

  // Synthesis: lock the private conversation after sections exist; the synthesis call must not be sent.
  const fakes = installFakes();
  createFakeWeb();
  const owner = await createUser("synth-revalidate");
  const conversation = await prisma.conversation.create({ data: { userId: owner.id, title: "Notes", kind: "chat", productKey: "chat", selectionMode: "manual", selectedModels: "[]" } });
  await prisma.message.create({ data: { id: randomUUID(), role: "user", content: "Private planning notes that only the analyst may read in full detail.", conversationId: conversation.id } });
  const privateRun = await create(owner.id, { sources: [{ type: "conversation", conversationId: conversation.id }] });
  for (let slice = 0; slice < 200; slice++) {
    const pending = await prisma.researchWorkItem.findFirst({ where: { runId: privateRun.id, kind: "synthesize", status: "queued" } });
    if (pending && !(await prisma.researchWorkItem.count({ where: { runId: privateRun.id, kind: { in: ["write_section", "verify"] }, status: { in: ["queued", "running"] } } }))) break;
    if (!(await processOneResearchWorkItem("synth-a"))) break;
  }
  const privateChunk = await prisma.researchEvidenceChunk.findFirstOrThrow({ where: { runId: privateRun.id, version: { source: { visibility: "private" } } } });
  const privateKeys = (await prisma.researchSourceVersion.findMany({ where: { runId: privateRun.id, source: { visibility: "private" }, objectKey: { not: null } },
    select: { objectKey: true } })).map((row) => row.objectKey!);
  await prisma.conversation.update({ where: { id: conversation.id }, data: { password: "hashed-placeholder", passwordVersion: { increment: 1 } } });
  const before = fakes.model.calls.filter((call) => call.tool === "submit_research_synthesis").length;
  await drainResearchWork("synth-b", 2);
  assert.equal(fakes.model.calls.filter((call) => call.tool === "submit_research_synthesis").length, before, "synthesis was not sent after the source was re-locked");
  assert.equal((await readResearchRunDto(owner.id, privateRun.id)).status, "completed", "a model-free partial report was kept");
  // The refused dispatch also revokes the source: its stored text is queued for cleanup and no longer served.
  const revokedSource = await prisma.researchSource.findFirstOrThrow({ where: { runId: privateRun.id, visibility: "private" } });
  assert.equal(revokedSource.status, "revoked");
  await rejects(readResearchEvidence({ userId: owner.id, runId: privateRun.id, chunkId: privateChunk.id }), "RESEARCH_EVIDENCE_UNAVAILABLE");
  assert.ok(privateKeys.length > 0);
  assert.equal(await prisma.researchEvidenceObjectCleanup.count({ where: { objectKey: { in: privateKeys } } }), privateKeys.length);
});

test("with an explicit public brief, the objective, constraints and priority notes never reach web search or a search-capable role", async () => {
  const fakes = installFakes();
  const web = createFakeWeb();
  const user = await createUser("public-brief");
  const run = await create(user.id, {
    brief: { ...brief("Private framing: KESTREL-77 internal merger plan. What do public sources say about regional tariffs?"),
      objective: "Decide on the KESTREL-77 acquisition", constraints: ["Budget KESTREL-77 is confidential"] },
    publicBrief: "What do public sources say about regional tariffs?",
  });
  await drainResearchWork("public-brief", 4);
  const mid = await readResearchRunDto(user.id, run.id);
  assert.equal(mid.status, "completed");
  assert.ok(web.searches.length > 0);
  assert.ok(web.searches.every((query) => !query.includes("KESTREL")), "no private framing in any search query");
  for (const call of fakes.model.calls) {
    if (["submit_research_plan", "submit_research_turn", "submit_research_coverage"].includes(call.tool)) assert.ok(!call.text.includes("KESTREL"), `${call.tool} saw private framing`);
  }
  // A private scope note and a format instruction never reach search-capable roles.
  await requestResearchRevision({ request: fakeRequest(), userId: user.id, runId: run.id,
    revision: { expectedReportRevision: mid.currentReportRevision, kind: "format", sectionKeys: [], instruction: "Frame it for the KESTREL-77 board" } });
  await drainResearchWork("public-brief-b", 4);
  assert.equal((await readResearchRunDto(user.id, run.id)).currentReportRevision, mid.currentReportRevision + 1);
  for (const call of fakes.model.calls) {
    if (["submit_research_plan", "submit_research_turn", "submit_research_coverage"].includes(call.tool)) assert.ok(!call.text.includes("KESTREL"), `${call.tool} saw a private note`);
  }
  assert.ok(fakes.model.calls.some((call) => call.tool === "submit_research_section" && call.text.includes("KESTREL-77 board")), "the writer did get the format instruction");
  assert.ok(web.searches.every((query) => !query.includes("KESTREL")));
  assert.equal(await prisma.researchEvidenceObjectCleanup.count({ where: { reason: "write_pending", objectKey: { contains: run.id } } }), 0,
    "every written object was taken over by its version row");
  // Without an explicit public text, the typed brief (question, objective, constraints) is the public text.
  const open = await create(user.id, { brief: { ...brief("Open question about tariffs?"), objective: "Compare regions", constraints: ["Use 2026 data"] } });
  const manifest = (await prisma.researchPreviewRun.findUniqueOrThrow({ where: { id: open.id } })).inputManifest as { publicBrief: string };
  assert.ok(manifest.publicBrief.includes("Compare regions") && manifest.publicBrief.includes("Use 2026 data"));
});

test("an evidence object written just before a crash is still deleted: its key is queued before the write", async () => {
  const fakes = installFakes({ model: createFakeModel({ respond: (call) => defaultResponse(call, { subquestions: 1, sections: 1, readsPerTurn: 1 }) }) });
  createFakeWeb();
  const user = await createUser("write-crash");
  const realPut = fakes.store.put;
  const written: string[] = [];
  // The process "dies" right after the object is stored: nothing after put runs.
  fakes.store.put = async (key, value) => { await realPut(key, value); written.push(key); throw new Error("process died after write"); };
  try {
    const run = await create(user.id);
    await drainResearchWork("write-crash", 2);
    assert.ok(written.length > 0, "at least one object was written");
    assert.equal(await prisma.researchSourceVersion.count({ where: { runId: run.id, objectKey: { in: written } } }), 0, "no version row recorded the key");
  } finally {
    fakes.store.put = realPut;
  }
  assert.ok(written.every((key) => fakes.store.objects.has(key)));
  assert.equal(await prisma.researchEvidenceObjectCleanup.count({ where: { objectKey: { in: written } } }), written.length, "every orphan is queued");
  await drainResearchEvidenceCleanup();
  assert.ok(written.every((key) => fakes.store.objects.has(key)), "inside the grace period the write may still be in flight");
  fakes.clock.advance(61 * 60_000);
  await drainResearchEvidenceCleanup();
  assert.ok(written.every((key) => !fakes.store.objects.has(key)), "orphaned objects are deleted after the grace period");
  // The fenced row stays for a final sweep, so a write that lands after the first delete is still removed.
  assert.equal(await prisma.researchEvidenceObjectCleanup.count({ where: { objectKey: { in: written }, reason: "write_abandoned" } }), written.length);
  for (const key of written) await realPut(key, "a late write that arrived after the first cleanup");
  fakes.clock.advance(24 * 60 * 60_000 + 60_000);
  await drainResearchEvidenceCleanup();
  assert.ok(written.every((key) => !fakes.store.objects.has(key)), "late objects are removed by the final sweep");
  assert.equal(await prisma.researchEvidenceObjectCleanup.count({ where: { objectKey: { in: written } } }), 0);
});

test("when search cannot be reserved for the model (admin turned web search off), no search request is ever sent", async () => {
  const fakes = installFakes();
  const web = createFakeWeb();
  const realEstimate = fakes.funding.adapter.estimate;
  const searchOff = async (input: Parameters<typeof realEstimate>[0]) => {
    if (input.searchEnabled) throw Object.assign(new Error("RESEARCH_SEARCH_UNAVAILABLE"), { code: "RESEARCH_SEARCH_UNAVAILABLE" });
    return realEstimate(input);
  };
  const user = await createUser("search-off");
  try {
    // Off before the run: creation is refused up front.
    fakes.funding.adapter.estimate = searchOff;
    await rejects(create(user.id), "RESEARCH_SEARCH_UNAVAILABLE");
    // Turned off mid-run: every researcher turn is refused before dispatch, so no search is sent.
    fakes.funding.adapter.estimate = realEstimate;
    const run = await create(user.id);
    fakes.funding.adapter.estimate = searchOff;
    await drainResearchWork("search-off", 2);
    assert.equal(web.searches.length, 0, "no paid search without a reserved search surcharge");
    assert.equal(await prisma.researchPreviewGeneration.count({ where: { runId: run.id, kind: "search" } }), 0);
    const state = await readResearchRunDto(user.id, run.id);
    assert.ok(["completed", "failed"].includes(state.status), `terminal, not stuck: ${state.status}`);
    const money = await readResearchRunMoney(prisma, run.id);
    assert.ok(money.settledCredits + money.reservedCredits <= money.approvedCredits);
  } finally {
    fakes.funding.adapter.estimate = realEstimate;
  }
});

test("a private copy stops being served once its original is deleted after the run, by read and by the maintenance sweep", async () => {
  const fakes = installFakes();
  createFakeWeb();
  const user = await createUser("post-run-revoke");
  const first = await memory(user.id, "Post-run memory one with private detail");
  const second = await memory(user.id, "Post-run memory two with private detail");
  const runA = await create(user.id, { sources: [{ type: "memory", memoryItemId: first.id }] });
  const runB = await create(user.id, { sources: [{ type: "memory", memoryItemId: second.id }] });
  await drainResearchWork("post-run-revoke", 4);
  assert.equal((await readResearchRunDto(user.id, runA.id)).status, "completed");
  // A selected private source marks the report private even if no private claim survived.
  const reportA = await readResearchReport({ userId: user.id, runId: runA.id });
  assert.equal(reportA.containsPrivate, true);
  assert.deepEqual(await researchShareContent(runA.id), { ok: false, code: "RESEARCH_SHARE_PRIVATE" });
  const chunkA = await prisma.researchEvidenceChunk.findFirstOrThrow({ where: { runId: runA.id, version: { source: { visibility: "private" } } } });
  await readResearchEvidence({ userId: user.id, runId: runA.id, chunkId: chunkA.id });
  const privateKeyA = (await prisma.researchSource.findFirstOrThrow({ where: { runId: runA.id, visibility: "private" } })).sourceKey;
  const derived = (await prisma.researchClaim.findMany({ where: { runId: runA.id } }))
    .filter((claim) => (claim.evidence as Array<{ sourceKey: string }>).some((evidence) => evidence.sourceKey === privateKeyA)).map((claim) => claim.text);
  assert.ok(derived.length > 0, "the report holds claims derived from the private source");
  await prisma.memoryItem.delete({ where: { id: first.id } });
  await rejects(readResearchEvidence({ userId: user.id, runId: runA.id, chunkId: chunkA.id }), "RESEARCH_EVIDENCE_UNAVAILABLE");
  assert.equal((await prisma.researchSource.findFirstOrThrow({ where: { runId: runA.id, visibility: "private" } })).status, "revoked");
  // The source list and the report stop showing the label copied from the deleted memory.
  const listedA = await listResearchSources({ userId: user.id, runId: runA.id, visibility: "private" });
  assert.ok(listedA.sources.every((source) => source.status === "revoked" && source.title === null && source.snippet === null));
  const rereadA = await readResearchReport({ userId: user.id, runId: runA.id });
  assert.ok(!JSON.stringify(rereadA.document.bibliography).includes("Post-run memory one"), "no copied label in the bibliography");
  const answerA = await prisma.message.findUniqueOrThrow({ where: { id: (await prisma.researchPreviewRun.findUniqueOrThrow({ where: { id: runA.id } })).assistantMessageId } });
  assert.ok(!answerA.content.includes("Post-run memory one"), "the chat answer was re-rendered without the copied label");
  // Text derived from the source is withheld too: claims, report blocks and summary, the
  // chat answer, the account export and the stored analysis findings that quote it.
  // The fake analyst writes the same claim text for every run, so only runA's export entry is checked (runB is not revoked yet).
  const findRun = (value: unknown): unknown => {
    if (!value || typeof value !== "object") return undefined;
    if ((value as { id?: unknown }).id === runA.id && "engineVersion" in value) return value;
    for (const child of Object.values(value)) { const found = findRun(child); if (found) return found; }
    return undefined;
  };
  const runAExport = findRun(await (await import("@/lib/accountDataExport")).buildAccountDataExport(user.id));
  assert.ok(runAExport, "the export carries runA");
  const exportedA = JSON.stringify(runAExport);
  const analyses = JSON.stringify((await prisma.researchWorkItem.findMany({ where: { runId: runA.id, kind: "analyze_private" } })).map((item) => item.result));
  for (const text of derived) {
    assert.ok(!JSON.stringify(rereadA).includes(text), "no derived claim text in the report");
    assert.ok(!answerA.content.includes(text), "no derived claim text in the chat answer");
    assert.ok(!exportedA.includes(text), "no derived claim text in the account export");
  }
  assert.ok(!analyses.includes("Post-run memory one"), "stored analysis findings no longer quote the source");
  // No read at all, and the source was excluded from scope first: the account export
  // re-checks it and carries no copied label anywhere.
  const excludedKey = (await prisma.researchSource.findFirstOrThrow({ where: { runId: runB.id, visibility: "private" } })).sourceKey;
  await prisma.researchSource.updateMany({ where: { runId: runB.id, sourceKey: excludedKey }, data: { status: "excluded" } });
  await prisma.memoryItem.delete({ where: { id: second.id } });
  const { buildAccountDataExport } = await import("@/lib/accountDataExport");
  const exported = JSON.stringify(await buildAccountDataExport(user.id));
  assert.ok(!exported.includes("Post-run memory two"), "account export carries no label of a deleted private source");
  assert.equal((await prisma.researchSource.findFirstOrThrow({ where: { runId: runB.id, visibility: "private" } })).status, "revoked");
  // The sweep also covers excluded sources: reset to excluded and let maintenance find it.
  await prisma.researchSource.updateMany({ where: { runId: runB.id, sourceKey: excludedKey }, data: { status: "excluded" } });
  const keysB = (await prisma.researchSourceVersion.findMany({ where: { runId: runB.id, source: { visibility: "private" } }, select: { objectKey: true } }))
    .map((row) => row.objectKey!).filter(Boolean);
  assert.ok(keysB.length > 0);
  const result = await recoverResearchEngine();
  assert.ok(result.revokedPrivateSources >= 1);
  assert.equal((await prisma.researchSource.findFirstOrThrow({ where: { runId: runB.id, visibility: "private" } })).status, "revoked");
  await drainResearchEvidenceCleanup();
  assert.ok(keysB.every((key) => !fakes.store.objects.has(key)), "the swept copy is deleted");
  assert.equal(await prisma.researchEvidenceObjectCleanup.count({ where: { objectKey: { in: keysB } } }), 0);
});

test("a private source revoked while its analysis is in flight never comes back through the late result or the report built after it", async () => {
  const user = await createUser("inflight-revoke");
  const secret = await memory(user.id, "In-flight memory naming project HELIOTROPE-7 budget");
  let revokedDuringCall = false;
  installFakes({ model: createFakeModel({ beforeRespond: async (call) => {
    if (call.tool !== "submit_research_private_analysis" || revokedDuringCall) return;
    revokedDuringCall = true;
    // The dispatch was sent with a valid grant; the original is deleted and revoked before it answers.
    await prisma.memoryItem.delete({ where: { id: secret.id } });
    const runRow = await prisma.researchPreviewRun.findFirstOrThrow({ where: { userId: user.id, engineVersion: 2 } });
    const source = await prisma.researchSource.findFirstOrThrow({ where: { runId: runRow.id, visibility: "private" } });
    await revokePrivateSource(runRow, source.id);
  } }) });
  createFakeWeb();
  const run = await create(user.id, { sources: [{ type: "memory", memoryItemId: secret.id }] });
  await drainResearchWork("inflight-revoke", 4);
  assert.ok(revokedDuringCall, "the revocation happened while the analysis was in flight");
  assert.equal((await readResearchRunDto(user.id, run.id)).status, "completed");
  const analyses = JSON.stringify((await prisma.researchWorkItem.findMany({ where: { runId: run.id, kind: "analyze_private" } })).map((item) => item.result));
  assert.ok(!analyses.includes("HELIOTROPE"), "the late analysis result was not stored with its quote");
  const claims = await prisma.researchClaim.findMany({ where: { runId: run.id } });
  assert.ok(claims.every((claim) => !claim.text.includes("Private note from")), "no claim keeps text derived from the revoked source");
  const report = JSON.stringify(await readResearchReport({ userId: user.id, runId: run.id }));
  const answer = (await prisma.message.findUniqueOrThrow({ where: { id: (await prisma.researchPreviewRun.findUniqueOrThrow({ where: { id: run.id } })).assistantMessageId } })).content;
  for (const leaked of ["HELIOTROPE", "Private note from"]) {
    assert.ok(!report.includes(leaked), `report: ${leaked}`);
    assert.ok(!answer.includes(leaked), `answer: ${leaked}`);
  }
});

test("a verification call never mixes claims from different private sources, so a revoked source cannot reach another claim's revised text", async () => {
  installFakes();
  createFakeWeb();
  const user = await createUser("verify-origin");
  const one = await memory(user.id, "Origin memory one with private detail");
  const two = await memory(user.id, "Origin memory two with private detail");
  const run = await create(user.id, { sources: [{ type: "memory", memoryItemId: one.id }, { type: "memory", memoryItemId: two.id }] });
  await drainResearchWork("verify-origin", 4);
  assert.equal((await readResearchRunDto(user.id, run.id)).status, "completed");
  const privateKeys = new Set((await prisma.researchSource.findMany({ where: { runId: run.id, visibility: "private" } })).map((source) => source.sourceKey));
  assert.equal(privateKeys.size, 2);
  const claims = await prisma.researchClaim.findMany({ where: { runId: run.id } });
  const originOf = (claimKey: string) => {
    const claim = claims.find((entry) => entry.claimKey === claimKey)!;
    const cited = [...new Set((claim.evidence as Array<{ sourceKey: string }>).map((evidence) => evidence.sourceKey).filter((key) => privateKeys.has(key)))].sort();
    return cited.length ? cited.join(",") : claim.privateDerived ? `alone:${claimKey}` : "public";
  };
  const batches = (await prisma.researchWorkItem.findMany({ where: { runId: run.id, kind: "verify" } }))
    .map((item) => (item.payload as { claimKeys: string[] }).claimKeys);
  const privateBatches = batches.filter((keys) => keys.some((key) => originOf(key) !== "public"));
  assert.ok(privateBatches.length >= 2, "each private source's claims are verified in their own call");
  for (const keys of batches) assert.equal(new Set(keys.map(originOf)).size, 1, `one origin per verification call: ${keys.join(",")}`);
});

test("a private finding whose quote cannot be verified is never kept as a claim, so no unattributed private text outlives the source", async () => {
  installFakes({ model: createFakeModel({ respond: (call) => call.tool === "submit_research_private_analysis"
    ? { findings: [{ text: "Unquoted private claim ZETA-44 about the budget.", kind: "fact",
        evidence: [{ sourceKey: /<evidence source="(P\d+)"/u.exec(call.text)?.[1] ?? "P1", quote: "this sentence is not in the private source" }] }], limitations: [] }
    : defaultResponse(call) }) });
  createFakeWeb();
  const user = await createUser("unquoted-private");
  const secret = await memory(user.id, "Unquoted memory with private detail");
  const run = await create(user.id, { sources: [{ type: "memory", memoryItemId: secret.id }] });
  await drainResearchWork("unquoted-private", 4);
  assert.equal((await readResearchRunDto(user.id, run.id)).status, "completed");
  const claims = await prisma.researchClaim.findMany({ where: { runId: run.id } });
  assert.ok(claims.every((claim) => !claim.text.includes("ZETA-44")), "the unverifiable private finding is not stored as a claim");
  const report = JSON.stringify(await readResearchReport({ userId: user.id, runId: run.id }));
  assert.ok(!report.includes("ZETA-44"));
  const { buildAccountDataExport } = await import("@/lib/accountDataExport");
  assert.ok(!JSON.stringify(await buildAccountDataExport(user.id)).includes("ZETA-44"), "nor in the account export");
});

test("revoking two private sources of one report leaves neither source's text in the report or the chat answer", async () => {
  installFakes();
  createFakeWeb();
  const user = await createUser("two-revoked");
  const one = await memory(user.id, "Two-revoke memory one with private detail");
  const two = await memory(user.id, "Two-revoke memory two with private detail");
  const run = await create(user.id, { sources: [{ type: "memory", memoryItemId: one.id }, { type: "memory", memoryItemId: two.id }] });
  await drainResearchWork("two-revoked", 4);
  assert.equal((await readResearchRunDto(user.id, run.id)).status, "completed");
  const derived = (await prisma.researchClaim.findMany({ where: { runId: run.id, privateDerived: true } })).map((claim) => claim.text);
  assert.ok(derived.length >= 2, "both private sources produced claims");
  await prisma.memoryItem.deleteMany({ where: { id: { in: [one.id, two.id] } } });
  await recoverResearchEngine();
  assert.equal(await prisma.researchSource.count({ where: { runId: run.id, visibility: "private", status: "revoked" } }), 2);
  const report = JSON.stringify(await readResearchReport({ userId: user.id, runId: run.id }));
  const answer = (await prisma.message.findUniqueOrThrow({ where: { id: (await prisma.researchPreviewRun.findUniqueOrThrow({ where: { id: run.id } })).assistantMessageId } })).content;
  for (const text of derived) {
    assert.ok(!report.includes(text), `report keeps: ${text}`);
    assert.ok(!answer.includes(text), `answer keeps: ${text}`);
  }
});

test("a report revision requested after a private source was revoked is synthesised normally, without the revoked source", async () => {
  installFakes();
  createFakeWeb();
  const user = await createUser("revision-after-revoke");
  const secret = await memory(user.id, "Revision memory with private detail");
  const run = await create(user.id, { sources: [{ type: "memory", memoryItemId: secret.id }] });
  await drainResearchWork("revision-after-revoke", 4);
  assert.equal((await readResearchRunDto(user.id, run.id)).status, "completed");
  await prisma.memoryItem.delete({ where: { id: secret.id } });
  await recoverResearchEngine();
  const before = await prisma.researchPreviewRun.findUniqueOrThrow({ where: { id: run.id } });
  await requestResearchRevision({ request: fakeRequest(), userId: user.id, runId: run.id,
    revision: { kind: "format", expectedReportRevision: before.currentReportRevision, sectionKeys: [], instruction: "Shorter, please." } });
  await drainResearchWork("revision-after-revoke-2", 4);
  const after = await prisma.researchPreviewRun.findUniqueOrThrow({ where: { id: run.id } });
  assert.equal(after.status, "completed");
  assert.ok(after.currentReportRevision > before.currentReportRevision);
  const synthesis = await prisma.researchWorkItem.findFirstOrThrow({ where: { runId: run.id, idempotencyKey: `synth:${after.currentReportRevision}` } });
  assert.equal(synthesis.status, "completed", "synthesis is not refused for a source that is already withheld");
  const report = await readResearchReport({ userId: user.id, runId: run.id });
  assert.ok(report.document.summary.includes("synthetic summary"), "the new revision has its own synthesis");
  const revoked = (await prisma.researchSource.findFirstOrThrow({ where: { runId: run.id, visibility: "private" } })).sourceKey;
  const current = await prisma.researchReportRevision.findUniqueOrThrow({ where: { runId_revision: { runId: run.id, revision: after.currentReportRevision } }, include: { claims: true } });
  assert.ok(current.claims.every((claim) => !(claim.evidence as Array<{ sourceKey: string }>).some((evidence) => evidence.sourceKey === revoked)),
    "claims withheld for the revoked source are not carried into the new revision");
});

test("evidence cleanup backs off through a long storage outage but never gives up", async () => {
  const fakes = installFakes();
  const objectKey = `research-evidence/outage/${randomUUID()}`;
  fakes.store.objects.set(objectKey, "private text that must eventually be deleted");
  await prisma.researchEvidenceObjectCleanup.create({ data: { objectKey, reason: "source_revoked" } });
  const realDelete = fakes.store.delete;
  fakes.store.delete = async () => { throw new Error("storage unavailable"); };
  try {
    for (let attempt = 0; attempt < 15; attempt++) {
      await drainResearchEvidenceCleanup();
      fakes.clock.advance(7 * 60 * 60_000);
    }
  } finally {
    fakes.store.delete = realDelete;
  }
  const row = await prisma.researchEvidenceObjectCleanup.findUniqueOrThrow({ where: { objectKey } });
  assert.equal(row.attempts, 15, "every failure is counted and the row stays queued");
  assert.ok(row.nextAttemptAt.getTime() - fakes.clock.now().getTime() <= 6 * 60 * 60_000, "backoff is capped");
  await drainResearchEvidenceCleanup();
  assert.equal(fakes.store.objects.has(objectKey), false, "the object is deleted once storage recovers");
  assert.equal(await prisma.researchEvidenceObjectCleanup.count({ where: { objectKey } }), 0);
});

test("a section revision keeps the parent's claim keys so kept sections still cite valid claims", async () => {
  installFakes({ model: createFakeModel({ respond: (call) => defaultResponse(call, { subquestions: 2, sections: 2 }) }) });
  createFakeWeb();
  const user = await createUser("revision-keys");
  const run = await create(user.id);
  await drainResearchWork("revision-keys-a", 2);
  const done = await readResearchRunDto(user.id, run.id);
  assert.equal(done.status, "completed");
  const parent = await prisma.researchReportRevision.findFirstOrThrow({ where: { runId: run.id, revision: done.currentReportRevision }, include: { claims: true } });
  const parentDocument = parent.document as { sections: Array<{ key: string; status: string }> };
  const written = parentDocument.sections.filter((section) => section.status === "written");
  assert.ok(written.length >= 2, "two written sections to keep one and revise the other");
  await requestResearchRevision({ request: fakeRequest(), userId: user.id, runId: run.id,
    revision: { expectedReportRevision: done.currentReportRevision, kind: "format", sectionKeys: [written[1]!.key], instruction: "Rewrite this section as a table" } });
  await drainResearchWork("revision-keys-b", 2);
  const revised = await readResearchRunDto(user.id, run.id);
  assert.equal(revised.currentReportRevision, done.currentReportRevision + 1);
  const child = await prisma.researchReportRevision.findFirstOrThrow({ where: { runId: run.id, revision: revised.currentReportRevision }, include: { claims: true } });
  const parentByKey = new Map(parent.claims.map((claim) => [claim.claimKey, claim.text]));
  for (const [key] of parentByKey) assert.ok(child.claims.some((claim) => claim.claimKey === key), `parent claim ${key} kept its key`);
  assert.equal(new Set(child.claims.map((claim) => claim.claimKey)).size, child.claims.length, "claim keys stay unique");
  // Every citation in the kept section resolves to a claim of the new revision with the same text.
  const kept = (child.document as { sections: Array<{ key: string; blocks: Array<{ claimKeys?: string[] }> }> }).sections.find((section) => section.key === written[0]!.key)!;
  const cited = kept.blocks.flatMap((block) => block.claimKeys ?? []);
  assert.ok(cited.length > 0, "the kept section cites claims");
  for (const key of cited) {
    const claim = child.claims.find((entry) => entry.claimKey === key);
    assert.ok(claim, `cited ${key} exists in the new revision`);
    assert.equal(claim.text, parentByKey.get(key), `cited ${key} is the same claim`);
  }
});

test("deleting the conversation of a run with an open or unknown hold keeps the hold's record, and expiry charges it instead of refunding", async () => {
  let turns = 0;
  const model = createFakeModel({ respond: (call) => {
    if (call.tool === "submit_research_turn" && turns++ === 0) return { usage: "unknown" };
    return defaultResponse(call, { subquestions: 1, sections: 1 });
  } });
  installFakes({ model });
  createFakeWeb();
  const user = await createUser("cascade");
  const run = await create(user.id);
  await drainResearchWork("cascade", 1, { maxSlices: 2 });
  const unknown = await prisma.researchFundingSegment.findFirstOrThrow({ where: { runId: run.id, status: "unknown" } });
  await prisma.conversation.delete({ where: { id: run.conversationId } });
  const orphan = await prisma.researchFundingSegment.findUniqueOrThrow({ where: { id: unknown.id } });
  assert.equal(orphan.runId, null, "the segment outlives its run");
  const { researchPreviewSettlementForExpiry } = await import("@/lib/deepResearchSettlementHandoff");
  const usage = await prisma.$transaction((tx) => researchPreviewSettlementForExpiry(tx, orphan.reservationId!));
  assert.equal(usage?.usageFromProvider, false, "charged conservatively, not refunded");
  const settled = await prisma.researchFundingSegment.findUniqueOrThrow({ where: { id: unknown.id } });
  assert.equal(settled.status, "settled");
  assert.equal(settled.settledCredits, settled.reservedCredits);
});
