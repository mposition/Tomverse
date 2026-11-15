import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, mock, test } from "node:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { MockLanguageModelV4 } from "ai/test";
import { prisma } from "@/lib/prisma";
import { buildAccountDataExport } from "@/lib/accountDataExport";
import {
  activateResearchPreviewRun,
  beginResearchPreviewGeneration,
  checkpointResearchPreviewRun,
  claimNextResearchPreviewRun,
  completeResearchPreviewGeneration,
  createPreparingResearchPreviewRun,
  markResearchPreviewDispatchStarted,
  readEligibleResearchPreviewSource,
  readResearchPreviewRunDto,
  recoverStaleResearchPreviewRun,
  requestResearchPreviewCancellation,
  researchPreviewQuestionDigest,
  resumeResearchPreviewRun,
} from "@/lib/researchPreviewRunStore";
import { parseResearchPreviewCheckpoint } from "@/lib/researchPreviewStep";
import { reconcileExpiredChatCreditReservations } from "@/lib/chatSecurity";

const root = resolve(import.meta.dirname, "../..");
const mod = (file: string) => pathToFileURL(resolve(root, file)).href;
const modelId = "gemini-3-1-pro";
let activeModel: MockLanguageModelV4;
let routeUserId: string | null = null;
mock.module(mod("lib/researchPreviewModel.ts"), {
  namedExports: { getResearchPreviewAiModel: () => activeModel },
});
mock.module(mod("lib/chatRouteSession.ts"), {
  namedExports: {
    resolveChatRouteSession: async () => ({
      session: routeUserId ? { user: { id: routeUserId } } : null,
    }),
  },
});

process.env.RESEARCH_PREVIEW_ENABLED = "true";
process.env.RESEARCH_PREVIEW_DURABLE_ENABLED = "true";
process.env.RESEARCH_PREVIEW_MODEL_IDS = modelId;
process.env.WEB_SEARCH_FAKE_BACKEND = "1";
process.env.GOOGLE_GENERATIVE_AI_API_KEY = "synthetic-model-never-sent";
process.env.CHAT_PROVIDER_GOOGLE_COST_MICROUSD_PER_DAY = "1000000000";
process.env.CHAT_PROVIDER_GOOGLE_COST_MICROUSD_PER_MONTH = "1000000000";

const users: string[] = [];
const reservations: string[] = [];

after(async () => {
  await prisma.user.deleteMany({ where: { id: { in: users } } });
  await prisma.chatCreditReservation.deleteMany({
    where: { id: { in: reservations } },
  });
  await prisma.$disconnect();
});

async function fixture(label: string) {
  const user = await prisma.user.create({
    data: { email: `${label}-${randomUUID()}@example.test`, plan: "Pro" },
  });
  users.push(user.id);
  const conversation = await prisma.conversation.create({
    data: {
      userId: user.id,
      title: label,
      kind: "chat",
      productKey: "chat",
      selectionMode: "manual",
      selectedModels: '["gemini-3-1-pro"]',
    },
  });
  const question = `Question for ${label}`;
  const source = await prisma.message.create({
    data: {
      id: randomUUID(),
      conversationId: conversation.id,
      role: "user",
      content: question,
    },
  });
  const reservationId = randomUUID();
  reservations.push(reservationId);
  await prisma.chatCreditReservation.create({
    data: {
      id: reservationId,
      userId: user.id,
      subjectKey: `test:${user.id}`,
      traceId: label,
      source: "chat",
      provider: "google",
      modelId: "gemini-3-1-pro",
      status: "reserved",
      idempotencyKey: `chat-credit-reservation:${reservationId}:v1`,
      reservationPayload: { fixture: true },
      reservedCredits: 12,
      reservedCostMicroUsd: BigInt(1_000_000),
      planReservedCredits: 12,
      addOnReservedCredits: 0,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000),
    },
  });
  const assistantMessageId = randomUUID();
  const prepared = await createPreparingResearchPreviewRun({
    userId: user.id,
    conversationId: conversation.id,
    sourceUserMessageId: source.id,
    assistantMessageId,
    modelId: "gemini-3-1-pro",
    provider: "google",
    apiModel: "gemini-3.1-pro-preview",
    locale: "en",
    currentDate: "2026-11-15",
    questionDigest: researchPreviewQuestionDigest(question),
    pageReadingEnabled: true,
    totalOutputTokens: 4096,
    inputTokenCeiling: 200_000,
    searchSurchargeCredits: 8,
  });
  assert.equal(prepared.created, true);
  await activateResearchPreviewRun({
    runId: prepared.run.id,
    userId: user.id,
    reservationId,
  });
  return {
    user,
    conversation,
    source,
    question,
    assistantMessageId,
    reservationId,
    runId: prepared.run.id,
  };
}

function checkpoint(input: {
  question: string;
  completedSteps: number;
  inputTokens: number;
  outputTokens: number;
}) {
  return parseResearchPreviewCheckpoint({
    version: 1,
    modelId: "gemini-3-1-pro",
    apiModel: "gemini-3.1-pro-preview",
    questionHash: createHash("sha256").update(input.question).digest("hex"),
    locale: "en",
    currentDate: "2026-11-15",
    totalOutputTokens: 4096,
    inputTokenCeiling: 200_000,
    pageReadingEnabled: true,
    reasoning: "provider-default",
    completedSteps: input.completedSteps,
    messages: [
      { role: "user", content: input.question },
      ...(input.completedSteps
        ? [
            {
              role: "assistant" as const,
              content: [{
                type: "tool-call" as const,
                toolCallId: "search-1",
                toolName: "web_search",
                input: { query: "fixture query" },
              }],
            },
            {
              role: "tool" as const,
              content: [{
                type: "tool-result" as const,
                toolCallId: "search-1",
                toolName: "web_search",
                output: { type: "text" as const, value: "No retained sources." },
              }],
            },
          ]
        : []),
    ],
    sources: [],
    search: {
      backend: "brave",
      backendRequestCount: 0,
      succeededRequestCount: 0,
      refusedCallCount: 0,
      executed: false,
      sources: [],
      maxQueries: 5,
    },
    successfulCache: [],
    pageReads: [],
    usage: {
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    },
    stopReason: null,
  });
}

function completedDurableModel() {
  const report = {
    status: "partial",
    summary: "The saved public sources support a bounded answer.",
    findings: [{
      heading: "Public evidence",
      statements: [{
        text: "The public source supports the finding.",
        sourceIds: ["R1"],
        kind: "fact",
      }],
    }],
    contradictions: [],
    limitations: ["This offline fixture uses bounded search excerpts."],
    nextQuestions: ["Which public release should be checked next?"],
  };
  return new MockLanguageModelV4({
    provider: "google",
    modelId: "gemini-3.1-pro-preview",
    doGenerate: async () => {
      const index = activeModel.doGenerateCalls.length - 1;
      assert.ok(index < 3, "durable Research must never add a repair generation");
      return {
        content: [{
          type: "tool-call" as const,
          toolCallId: `durable-${index}`,
          toolName: index < 2 ? "web_search" : "submit_research_report",
          input: JSON.stringify(
            index < 2
              ? { query: index === 0 ? "first public release" : "second public release" }
              : report
          ),
        }],
        usage: {
          inputTokens: {
            total: 200 + index * 100,
            noCache: 200 + index * 100,
            cacheRead: 0,
            cacheWrite: 0,
          },
          outputTokens: {
            total: 100 + index * 100,
            text: 80 + index * 100,
            reasoning: 20,
          },
        },
        warnings: [],
        finishReason: { unified: "tool-calls" as const, raw: "fixture" },
      };
    },
  });
}

async function createServiceFixture(label: string) {
  const user = await prisma.user.create({
    data: {
      email: `${label}-${randomUUID()}@example.test`,
      plan: "Pro",
      subscriptionStatus: "active",
      subscriptionCurrentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
    },
  });
  users.push(user.id);
  routeUserId = user.id;
  const conversation = await prisma.conversation.create({
    data: {
      userId: user.id,
      title: label,
      kind: "chat",
      productKey: "chat",
      selectionMode: "manual",
      selectedModels: JSON.stringify([modelId]),
    },
  });
  const source = await prisma.message.create({
    data: {
      id: randomUUID(),
      conversationId: conversation.id,
      role: "user",
      content: "Compare two public product release notes.",
    },
  });
  const assistantMessageId = randomUUID();
  const request = new Request("http://127.0.0.1/api/chat/research-preview/runs", {
    method: "POST",
    headers: { "Accept-Language": "en" },
  });
  activeModel = completedDurableModel();
  const service = await import(mod("lib/researchPreviewRunService.ts"));
  const created = await service.createDurableResearchPreviewRun({
    request,
    userId: user.id,
    payload: {
      conversationId: conversation.id,
      sourceUserMessageId: source.id,
      assistantMessageId,
      modelId,
      locale: "en",
    },
  });
  assert.equal(created.created, true);
  const held = await prisma.chatCreditReservation.findMany({
    where: { userId: user.id },
  });
  assert.equal(held.length, 1);
  assert.equal(held[0]?.status, "reserved");
  reservations.push(held[0]!.id);

  return { user, conversation, source, assistantMessageId, request, service, created, held };
}

test("cancelling an undispatched queued run settles known zero tokens, search cost and credits", async () => {
  const { user, service, created, held } = await createServiceFixture("queued-cancel");
  await service.cancelDurableResearchPreviewRun({ userId: user.id, runId: created.run.id });
  const reservation = await prisma.chatCreditReservation.findUniqueOrThrow({ where: { id: held[0]!.id } });
  assert.equal(reservation.status, "refunded");
  assert.equal(reservation.settledCredits, 0);
  assert.equal(reservation.settledInputTokens, 0);
  assert.equal(reservation.settledOutputTokens, 0);
  assert.equal(reservation.settledCostMicroUsd, BigInt(0));
  assert.equal(activeModel.doGenerateCalls.length, 0);
  const attempts = await prisma.chatAttemptUsage.findMany({ where: { reservationId: reservation.id } });
  assert.ok(attempts.every(attempt => attempt.inputTokens === 0 && attempt.outputTokens === 0 && attempt.costMicroUsd === BigInt(0)));
});

for (const viaSweep of [false, true]) test(`expired paid checkpoints preserve known usage and clear private data through ${viaSweep ? "generic reservation expiry" : "worker recovery"}`, async () => {
  const { service, created, held } = await createServiceFixture(`expired-${viaSweep}`);
  await service.processOneResearchPreviewRun("expiry-worker", { maxStepsPerClaim: 1 });
  const cutoff = new Date(Date.now() - 1000);
  await prisma.chatCreditReservation.update({ where: { id: held[0]!.id }, data: { expiresAt: cutoff } });
  if (viaSweep) {
    await reconcileExpiredChatCreditReservations();
    const active = await prisma.chatCreditReservation.findUniqueOrThrow({ where: { id: held[0]!.id } });
    assert.equal(active.status, "reserved", "a still-valid checkpoint cannot become a generic zero refund");
  }
  await prisma.researchPreviewRun.update({ where: { id: created.run.id }, data: { checkpointExpiresAt: cutoff } });
  if (viaSweep) {
    await reconcileExpiredChatCreditReservations();
  } else await service.recoverStaleResearchPreviewRuns();
  const run = await prisma.researchPreviewRun.findUniqueOrThrow({ where: { id: created.run.id } });
  assert.equal(run.status, "failed");
  assert.equal(run.stopReason, "checkpoint_expired");
  assert.equal(run.checkpoint, null);
  assert.equal(run.checkpointExpiresAt, null);
  const reservation = await prisma.chatCreditReservation.findUniqueOrThrow({ where: { id: held[0]!.id } });
  assert.ok(["settled", "refunded"].includes(reservation.status), "user-credit refund status does not erase provider spend");
  assert.equal(reservation.settledInputTokens, 200);
  assert.equal(reservation.settledOutputTokens, 100);
  assert.equal(activeModel.doGenerateCalls.length, 1);
  const attempt = await prisma.chatAttemptUsage.findFirstOrThrow({ where: { reservationId: reservation.id } });
  assert.equal(attempt.usageSource, "provider_usage_metadata");
  assert.equal(attempt.inputTokens, 200);
  assert.equal(attempt.outputTokens, 100);
  assert.ok(attempt.costMicroUsd > BigInt(0));
});

for (const pauseAfterFirst of [false, true]) test(`the real durable service reserves once and completes three steps${pauseAfterFirst ? " across an explicit checkpoint and resume" : " in one claim"}`, async () => {
  const { user, conversation, source, assistantMessageId, request, service, created, held } = await createServiceFixture("durable-service");
  if (pauseAfterFirst) {
    await assert.rejects(service.processOneResearchPreviewRun("invalid-worker", { maxStepsPerClaim: 4 }), /step limit/);
    assert.equal(activeModel.doGenerateCalls.length, 0);
    assert.equal(await service.processOneResearchPreviewRun("checkpoint-worker", { maxStepsPerClaim: 1 }), true);
    const paused = await readResearchPreviewRunDto(user.id, created.run.id);
    assert.equal(paused?.status, "checkpointed");
    assert.equal(paused?.canResume, true);
    assert.equal(activeModel.doGenerateCalls.length, 1);
    assert.equal(await prisma.chatCreditReservation.count({ where: { userId: user.id } }), 1);
    const { POST } = await import(mod("app/api/chat/research-preview/runs/[id]/resume/route.ts"));
    const resumed = await POST(new Request(`http://127.0.0.1/api/chat/research-preview/runs/${created.run.id}/resume`, { method: "POST" }),
      { params: Promise.resolve({ id: created.run.id }) });
    assert.equal(resumed.status, 200);
    assert.equal(activeModel.doGenerateCalls.length, 1, "resume queues the existing checkpoint without dispatching");
  }
  assert.equal(await service.processOneResearchPreviewRun("durable-service-worker"), true);
  const run = await prisma.researchPreviewRun.findUniqueOrThrow({
    where: { id: created.run.id },
    include: { generations: { orderBy: { generationIndex: "asc" } } },
  });
  assert.equal(
    run.status,
    "completed",
    JSON.stringify({
      stopReason: run.stopReason,
      lastErrorCode: run.lastErrorCode,
      modelCalls: activeModel.doGenerateCalls.length,
      generations: run.generations.map((generation) => generation.status),
    })
  );
  assert.equal(activeModel.doGenerateCalls.length, 3);
  assert.equal(run.checkpoint, null);
  assert.equal(run.stepCount, 3);
  assert.equal(run.searchCount, 2);
  assert.equal(run.generations.length, 3);
  assert.deepEqual(run.generations.map((generation) => generation.status), [
    "completed",
    "completed",
    "completed",
  ]);
  const message = await prisma.message.findUniqueOrThrow({
    where: { id: assistantMessageId },
  });
  assert.equal(message.researchRunId, created.run.id);
  assert.match(message.content, /bounded answer/i);
  assert.equal(
    (message.searchMetadata as { research: { outcome: string } }).research.outcome,
    "partial"
  );
  const reservation = await prisma.chatCreditReservation.findUniqueOrThrow({
    where: { id: held[0]!.id },
  });
  assert.equal(reservation.status, "settled");
  assert.equal(reservation.settledInputTokens, 900);
  assert.equal(reservation.settledOutputTokens, 600);
  const providerAttempt = await prisma.chatAttemptUsage.findFirstOrThrow({
    where: { reservationId: reservation.id },
  });
  assert.equal(providerAttempt.usageSource, "provider_usage_metadata");
  assert.equal(providerAttempt.inputTokens, 900);
  assert.equal(providerAttempt.outputTokens, 600);

  const duplicate = await service.createDurableResearchPreviewRun({
    request,
    userId: user.id,
    payload: {
      conversationId: conversation.id,
      sourceUserMessageId: source.id,
      assistantMessageId,
      modelId,
      locale: "en",
    },
  });
  assert.equal(duplicate.created, false);
  assert.equal(
    await prisma.chatCreditReservation.count({ where: { userId: user.id } }),
    1
  );
  const { GET } = await import(mod("app/api/chat/research-preview/runs/[id]/route.ts"));
  const response = await GET(
    new Request(`http://127.0.0.1/api/chat/research-preview/runs/${created.run.id}`),
    { params: Promise.resolve({ id: created.run.id }) }
  );
  assert.equal(response.status, 200);
  const body = await response.json() as { run: { status: string; message?: { id: string } } };
  assert.equal(body.run.status, "completed");
  assert.equal(body.run.message?.id, assistantMessageId);
  assert.equal(activeModel.doGenerateCalls.length, 3, "idempotency and GET are read-only");
});

test("an existing Message response identity is refused before any hold or dispatch", async () => {
  const user = await prisma.user.create({
    data: {
      email: `identity-collision-${randomUUID()}@example.test`,
      plan: "Pro",
      subscriptionStatus: "active",
      subscriptionCurrentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
    },
  });
  users.push(user.id);
  const conversation = await prisma.conversation.create({
    data: {
      userId: user.id,
      title: "identity collision",
      kind: "chat",
      productKey: "chat",
      selectionMode: "manual",
      selectedModels: JSON.stringify([modelId]),
    },
  });
  const source = await prisma.message.create({
    data: {
      id: randomUUID(),
      conversationId: conversation.id,
      role: "user",
      content: "Research a public topic.",
    },
  });
  const occupiedId = randomUUID();
  await prisma.message.create({
    data: {
      id: occupiedId,
      conversationId: conversation.id,
      role: "assistant",
      content: "Existing ordinary Chat response.",
      modelId,
    },
  });
  activeModel = completedDurableModel();
  const service = await import(mod("lib/researchPreviewRunService.ts"));
  await assert.rejects(
    service.createDurableResearchPreviewRun({
      request: new Request("http://127.0.0.1/api/chat/research-preview/runs", {
        method: "POST",
      }),
      userId: user.id,
      payload: {
        conversationId: conversation.id,
        sourceUserMessageId: source.id,
        assistantMessageId: occupiedId,
        modelId,
      },
    }),
    /RESEARCH_RUN_ID_REUSED/
  );
  assert.equal(
    await prisma.chatCreditReservation.count({ where: { userId: user.id } }),
    0
  );
  assert.equal(activeModel.doGenerateCalls.length, 0);
});

test("stale preparing runs fail without retry and reconcile a real orphaned hold", async () => {
  const user = await prisma.user.create({
    data: {
      email: `stale-preparing-${randomUUID()}@example.test`,
      plan: "Pro",
      subscriptionStatus: "active",
      subscriptionCurrentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
    },
  });
  users.push(user.id);
  const firstConversation = await prisma.conversation.create({
    data: {
      userId: user.id,
      title: "before hold crash",
      kind: "chat",
      productKey: "chat",
      selectionMode: "manual",
      selectedModels: JSON.stringify([modelId]),
    },
  });
  const firstSource = await prisma.message.create({
    data: { id: randomUUID(), conversationId: firstConversation.id, role: "user", content: "Crash before a hold." },
  });
  const beforeHold = await createPreparingResearchPreviewRun({
    userId: user.id,
    conversationId: firstConversation.id,
    sourceUserMessageId: firstSource.id,
    assistantMessageId: randomUUID(),
    modelId,
    provider: "google",
    apiModel: "gemini-3.1-pro-preview",
    locale: "en",
    currentDate: "2026-11-15",
    questionDigest: researchPreviewQuestionDigest(firstSource.content),
    pageReadingEnabled: false,
    totalOutputTokens: 4096,
    inputTokenCeiling: 200_000,
    searchSurchargeCredits: 8,
  });
  await prisma.researchPreviewRun.update({
    where: { id: beforeHold.run.id },
    data: { createdAt: new Date(Date.now() - 120_000) },
  });
  activeModel = completedDurableModel();
  const service = await import(mod("lib/researchPreviewRunService.ts"));
  assert.equal(await service.recoverStaleResearchPreviewRuns(), 1);
  const failedBeforeHold = await prisma.researchPreviewRun.findUniqueOrThrow({ where: { id: beforeHold.run.id } });
  assert.equal(failedBeforeHold.status, "failed");
  assert.equal(failedBeforeHold.reservationId, null);

  const secondConversation = await prisma.conversation.create({
    data: {
      userId: user.id,
      title: "after hold crash",
      kind: "chat",
      productKey: "chat",
      selectionMode: "manual",
      selectedModels: JSON.stringify([modelId]),
    },
  });
  const secondSource = await prisma.message.create({
    data: { id: randomUUID(), conversationId: secondConversation.id, role: "user", content: "Crash after a hold." },
  });
  const afterHold = await service.createDurableResearchPreviewRun({
    request: new Request("http://127.0.0.1/api/chat/research-preview/runs", { method: "POST" }),
    userId: user.id,
    payload: {
      conversationId: secondConversation.id,
      sourceUserMessageId: secondSource.id,
      assistantMessageId: randomUUID(),
      modelId,
      locale: "en",
    },
  });
  const held = await prisma.chatCreditReservation.findFirstOrThrow({ where: { userId: user.id, traceId: afterHold.run.id } });
  reservations.push(held.id);
  await prisma.researchPreviewRun.update({
    where: { id: afterHold.run.id },
    data: { status: "preparing", reservationId: null, createdAt: new Date(Date.now() - 120_000) },
  });
  assert.equal(await service.recoverStaleResearchPreviewRuns(), 1);
  const failedAfterHold = await prisma.researchPreviewRun.findUniqueOrThrow({
    where: { id: afterHold.run.id },
    include: { generations: true },
  });
  assert.equal(failedAfterHold.status, "failed");
  assert.equal(failedAfterHold.reservationId, held.id);
  assert.equal(failedAfterHold.settlementUsage, null);
  assert.equal(failedAfterHold.generations.length, 0);
  assert.notEqual((await prisma.chatCreditReservation.findUniqueOrThrow({ where: { id: held.id } })).status, "reserved");
  assert.equal(activeModel.doGenerateCalls.length, 0);
});

test("a persisted attachment makes the saved source ineligible before reservation", async () => {
  const user = await prisma.user.create({
    data: { email: `attached-${randomUUID()}@example.test`, plan: "Pro" },
  });
  users.push(user.id);
  const conversation = await prisma.conversation.create({
    data: {
      userId: user.id,
      title: "attached source",
      kind: "chat",
      productKey: "chat",
      selectionMode: "manual",
      selectedModels: '["gemini-3-1-pro"]',
    },
  });
  const source = await prisma.message.create({
    data: {
      id: randomUUID(),
      conversationId: conversation.id,
      role: "user",
      content: "Research the attached source",
    },
  });
  await prisma.messageAttachment.create({
    data: {
      messageId: source.id,
      conversationId: conversation.id,
      userId: user.id,
      name: "private.txt",
      mediaType: "text/plain",
      size: 12,
      kind: "text",
      objectKey: `research-preview-test/${randomUUID()}`,
    },
  });

  assert.equal(
    await readEligibleResearchPreviewSource({
      userId: user.id,
      conversationId: conversation.id,
      sourceUserMessageId: source.id,
    }),
    null
  );
  assert.equal(
    await prisma.researchPreviewRun.count({ where: { sourceUserMessageId: source.id } }),
    0
  );
});

test("one completed generation checkpoints and resumes the same reservation without a second hold", async () => {
  const row = await fixture("safe-checkpoint");
  const duplicate = await createPreparingResearchPreviewRun({
    userId: row.user.id,
    conversationId: row.conversation.id,
    sourceUserMessageId: row.source.id,
    assistantMessageId: row.assistantMessageId,
    modelId: "gemini-3-1-pro",
    provider: "google",
    apiModel: "gemini-3.1-pro-preview",
    locale: "en",
    currentDate: "2026-11-15",
    questionDigest: researchPreviewQuestionDigest(row.question),
    pageReadingEnabled: true,
    totalOutputTokens: 4096,
    inputTokenCeiling: 200_000,
    searchSurchargeCredits: 8,
  });
  assert.equal(duplicate.created, false);

  const claimed = await claimNextResearchPreviewRun("worker-safe");
  assert.equal(claimed?.id, row.runId);
  if (!claimed) throw new Error("Expected queued run");
  const generation = await beginResearchPreviewGeneration({
    runId: claimed.id,
    ownerId: "worker-safe",
    leaseEpoch: claimed.leaseEpoch,
    checkpointVersion: 0,
    generationIndex: 1,
  });
  await markResearchPreviewDispatchStarted({
    runId: claimed.id,
    generationId: generation.id,
    ownerId: "worker-safe",
    leaseEpoch: claimed.leaseEpoch,
  });
  const next = checkpoint({
    question: row.question,
    completedSteps: 1,
    inputTokens: 120,
    outputTokens: 40,
  });
  await completeResearchPreviewGeneration({
    runId: claimed.id,
    generationId: generation.id,
    ownerId: "worker-safe",
    leaseEpoch: claimed.leaseEpoch,
    checkpoint: next,
    stepCount: 1,
    searchCount: 0,
    readCount: 0,
    stepUsage: {
      inputTokens: 120,
      outputTokens: 40,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      reasoningTokens: 0,
    },
    settlementUsage: {
      inputTokens: 120,
      outputTokens: 40,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      reasoningTokens: 0,
      usageFromProvider: true,
      outcome: "failed",
      searchSurchargeCredits: 8,
      searchExecuted: false,
      searchQueryCount: 0,
      searchBackendRequestCount: 0,
      searchQueriesObserved: true,
    },
  });
  assert.equal(
    await checkpointResearchPreviewRun({
      runId: claimed.id,
      ownerId: "worker-safe",
      leaseEpoch: claimed.leaseEpoch,
    }),
    true
  );
  const paused = await readResearchPreviewRunDto(row.user.id, row.runId);
  assert.equal(paused?.status, "checkpointed");
  assert.equal(paused?.canResume, true);
  assert.equal("checkpoint" in (paused ?? {}), false);

  await resumeResearchPreviewRun(row.user.id, row.runId);
  const resumed = await prisma.researchPreviewRun.findUniqueOrThrow({
    where: { id: row.runId },
  });
  assert.equal(resumed.status, "queued");
  assert.equal(resumed.reservationId, row.reservationId);
  assert.equal(
    await prisma.chatCreditReservation.count({ where: { id: row.reservationId } }),
    1
  );

  const exported = await buildAccountDataExport(row.user.id);
  const exportedRun = (exported.data.research_preview_runs as Array<Record<string, unknown>>)
    .find((entry) => entry.id === row.runId);
  assert.ok(exportedRun);
  assert.deepEqual(Object.keys(exportedRun).sort(), [
    "assistantMessageId", "completedAt", "conversationId", "createdAt", "id",
    "modelId", "readCount", "searchCount", "startedAt", "status", "stepCount",
    "stopReason", "updatedAt",
  ]);
  assert.doesNotMatch(
    JSON.stringify(exportedRun),
    /checkpoint|reservation|provider|apiModel|settlement|question/i
  );
  await requestResearchPreviewCancellation(row.user.id, row.runId);
});

test("a stale dispatch is quarantined as outcome_unknown and can never resume", async () => {
  const row = await fixture("unknown-dispatch");
  const claimed = await claimNextResearchPreviewRun("worker-unknown");
  assert.equal(claimed?.id, row.runId);
  if (!claimed) throw new Error("Expected queued run");
  const generation = await beginResearchPreviewGeneration({
    runId: claimed.id,
    ownerId: "worker-unknown",
    leaseEpoch: claimed.leaseEpoch,
    checkpointVersion: 0,
    generationIndex: 1,
  });
  await markResearchPreviewDispatchStarted({
    runId: claimed.id,
    generationId: generation.id,
    ownerId: "worker-unknown",
    leaseEpoch: claimed.leaseEpoch,
  });
  await prisma.researchPreviewRun.update({
    where: { id: row.runId },
    data: { leaseExpiresAt: new Date(Date.now() - 1_000) },
  });
  assert.equal(await recoverStaleResearchPreviewRun(row.runId), "outcome_unknown");
  const stored = await prisma.researchPreviewRun.findUniqueOrThrow({
    where: { id: row.runId },
    include: { generations: true },
  });
  assert.equal(stored.status, "attention");
  assert.equal(stored.stopReason, "outcome_unknown");
  assert.equal(stored.checkpoint, null);
  assert.equal(stored.generations[0]?.status, "outcome_unknown");
  assert.equal(
    (stored.settlementUsage as Record<string, unknown>).searchQueriesObserved,
    false
  );
  const dto = await readResearchPreviewRunDto(row.user.id, row.runId);
  assert.equal(dto?.canResume, false);
  await assert.rejects(
    resumeResearchPreviewRun(row.user.id, row.runId),
    /no safe checkpoint/i
  );
});

test("account deletion cascades run/checkpoint rows while the financial reservation survives anonymized", async () => {
  const row = await fixture("account-delete");
  await prisma.user.delete({ where: { id: row.user.id } });
  assert.equal(await prisma.researchPreviewRun.count({ where: { id: row.runId } }), 0);
  const reservation = await prisma.chatCreditReservation.findUniqueOrThrow({
    where: { id: row.reservationId },
  });
  assert.equal(reservation.userId, null);
  users.splice(users.indexOf(row.user.id), 1);
});
