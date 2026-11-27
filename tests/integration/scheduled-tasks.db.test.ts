import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";

import { buildAccountDataExport } from "@/lib/accountDataExport";
import { prisma } from "@/lib/prisma";
import { SCHEDULED_TASKS_FLAG_KEY } from "@/lib/scheduledTaskAccess";
import { SCHEDULED_TASK_LIMITS } from "@/lib/scheduledTaskCore";
import { scheduledTaskReservationGuard } from "@/lib/scheduledTaskReservationGuard";
import { runAsScheduledTask, scheduledTaskRunSession } from "@/lib/scheduledTaskRunContext";
import {
  reconcileExpiredScheduledRuns,
  runScheduledTasksTick,
  scheduledRunAssistantMessageId,
  type ChatDispatch,
} from "@/lib/scheduledTaskRunner";
import { quoteScheduledRunCredits } from "@/lib/scheduledTaskService";

/**
 * The unattended-spend boundary against a real database: the claim keys, the
 * one-in-flight slot, the reservation guard's transaction, and what a run
 * leaves behind. The Chat route itself is replaced by `dispatch` fakes that
 * behave like its durable stored-Chat path (claim an attempt, reserve through
 * the guard, finish); no provider is ever called.
 */

const MODEL_ID = "gpt-6-luna";
const FINGERPRINT = "a".repeat(64);

const reset = async () => {
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "ScheduledTaskRun",
      "ScheduledTask",
      "ChatResponseAttempt",
      "ChatRequestLease",
      "Message",
      "Conversation",
      "UserSettings",
      "User"
    RESTART IDENTITY CASCADE
  `);
  await prisma.appSetting.deleteMany({ where: { key: SCHEDULED_TASKS_FLAG_KEY } });
};

beforeEach(reset);
after(async () => {
  await reset();
  await prisma.$disconnect();
});

const enable = () =>
  prisma.appSetting.upsert({
    where: { key: SCHEDULED_TASKS_FLAG_KEY },
    update: { value: "true" },
    create: { key: SCHEDULED_TASKS_FLAG_KEY, value: "true" },
  });

async function seedUser(plan = "Pro") {
  const id = randomUUID();
  await prisma.user.create({ data: { id, email: `${id}@example.invalid`, plan } });
  await prisma.userSettings.create({ data: { userId: id, defaultModel: MODEL_ID, timeZone: "UTC", language: "ko" } });
  return id;
}

async function seedTask(userId: string, overrides: Record<string, unknown> = {}) {
  const creditsPerRun = await quoteScheduledRunCredits({ userId, modelId: MODEL_ID, prompt: "Summarise today's AI news.", webSearch: false });
  return prisma.scheduledTask.create({
    data: {
      userId,
      title: "Morning news",
      prompt: "Summarise today's AI news.",
      modelId: MODEL_ID,
      webSearch: false,
      frequency: "daily",
      timeOfDay: "08:00",
      timeZone: "UTC",
      status: "active",
      creditsPerRun,
      nextRunAt: new Date(Date.now() - 60_000),
      ...overrides,
    },
  });
}

type Call = { body: Record<string, unknown>; sessionUserId: string | null };

/** Behaves like the Chat route's durable path: guard, attempt, stream. */
const completingChat = (calls: Call[], credits = 1): ChatDispatch => async (request) => {
  const session = scheduledTaskRunSession(request);
  const body = (await request.json()) as Record<string, string>;
  calls.push({ body, sessionUserId: session?.user?.id ?? null });
  if (!session?.user?.id) return Response.json({ code: "AUTHENTICATION_REQUIRED" }, { status: 401 });
  const guard = scheduledTaskReservationGuard(session.user.id);
  assert.ok(guard, "a scheduled run must carry the reservation guard");
  try {
    await prisma.$transaction((tx) => guard(tx, { reservationId: randomUUID(), usageCredits: credits }));
  } catch (error) {
    const refusal = error as { status: number; code: string };
    return Response.json({ code: refusal.code }, { status: refusal.status });
  }
  await prisma.chatResponseAttempt.create({
    data: {
      assistantMessageId: body.assistantMessageId,
      userId: session.user.id,
      conversationId: body.conversationId,
      sourceUserMessageId: body.sourceUserMessageId,
      fingerprint: FINGERPRINT,
      requestedModelId: body.modelId,
      status: "completed",
      ownerId: "fake-owner",
      leaseExpiresAt: new Date(Date.now() + 60_000),
      finishReason: "stop",
      terminalAt: new Date(),
    },
  });
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("answer"));
      controller.close();
    },
  }), { status: 200 });
};

const refusingChat = (status: number, code: string, calls: Call[] = []): ChatDispatch => async (request) => {
  calls.push({ body: (await request.json()) as Record<string, unknown>, sessionUserId: scheduledTaskRunSession(request)?.user?.id ?? null });
  return Response.json({ code }, { status });
};

const neverCalled = (): ChatDispatch => async () => {
  throw new Error("dispatch must not be reached");
};

test("with the switch off nothing is read, claimed or sent", async () => {
  const userId = await seedUser();
  const task = await seedTask(userId);
  let dispatched = 0;
  const result = await runScheduledTasksTick({ dispatch: async () => { dispatched += 1; return neverCalled(); } });
  assert.equal(result.enabled, false);
  assert.equal(dispatched, 0);
  assert.equal(await prisma.scheduledTaskRun.count(), 0);
  const unchanged = await prisma.scheduledTask.findUniqueOrThrow({ where: { id: task.id } });
  assert.equal(unchanged.nextRunAt?.getTime(), task.nextRunAt?.getTime());
  // An explicit "false" and any value other than "true" are off too.
  for (const value of ["false", "TRUE", "1"]) {
    await prisma.appSetting.upsert({ where: { key: SCHEDULED_TASKS_FLAG_KEY }, update: { value }, create: { key: SCHEDULED_TASKS_FLAG_KEY, value } });
    assert.equal((await runScheduledTasksTick({ dispatch: async () => neverCalled() })).enabled, false, value);
  }
  assert.equal(await prisma.scheduledTaskRun.count(), 0);
});

test("a due task runs once as its account, answers into its own conversation and schedules the next day", async () => {
  await enable();
  const userId = await seedUser();
  const task = await seedTask(userId);
  const calls: Call[] = [];
  const result = await runScheduledTasksTick({ dispatch: async () => completingChat(calls) });
  assert.equal(result.claimed, 1);
  assert.deepEqual(result.executed, { completed: 1 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.sessionUserId, userId);

  const run = await prisma.scheduledTaskRun.findFirstOrThrow({ where: { taskId: task.id } });
  assert.equal(run.status, "succeeded");
  assert.equal(run.runningUserId, null);
  assert.equal(run.reservedCredits, 1);
  assert.ok(run.chatReservationId);
  assert.equal(run.assistantMessageId, scheduledRunAssistantMessageId(run.id));
  assert.equal(calls[0]!.body.assistantMessageId, run.assistantMessageId);
  assert.equal(calls[0]!.body.webSearchMode, "off");

  const updated = await prisma.scheduledTask.findUniqueOrThrow({ where: { id: task.id } });
  assert.ok(updated.conversationId);
  assert.equal(updated.status, "active");
  assert.equal(updated.consecutiveFailures, 0);
  assert.ok(updated.nextRunAt && updated.nextRunAt.getTime() > Date.now());
  const conversation = await prisma.conversation.findUniqueOrThrow({ where: { id: updated.conversationId! } });
  assert.equal(conversation.userId, userId);
  assert.equal(conversation.productKey, "chat");
  assert.deepEqual(JSON.parse(conversation.selectedModels), [MODEL_ID]);
  const question = await prisma.message.findUniqueOrThrow({ where: { id: run.userMessageId! } });
  assert.equal(question.conversationId, conversation.id);
  assert.equal(question.content, task.prompt);

  // The next tick finds nothing due and sends nothing.
  const again = await runScheduledTasksTick({ dispatch: async () => neverCalled() });
  assert.equal(again.claimed, 0);
  assert.equal(await prisma.scheduledTaskRun.count(), 1);
});

test("two ticks racing for one occurrence produce one run", async () => {
  await enable();
  const userId = await seedUser();
  await seedTask(userId);
  const calls: Call[] = [];
  await Promise.all([
    runScheduledTasksTick({ dispatch: async () => completingChat(calls) }),
    runScheduledTasksTick({ dispatch: async () => completingChat(calls) }),
  ]);
  assert.equal(await prisma.scheduledTaskRun.count(), 1);
  assert.equal(calls.length, 1);
});

test("an account has one scheduled run in flight; its second due task waits for the next tick", async () => {
  await enable();
  const userId = await seedUser();
  const first = await seedTask(userId, { nextRunAt: new Date(Date.now() - 120_000) });
  const second = await seedTask(userId, { title: "Second" });
  const calls: Call[] = [];
  const result = await runScheduledTasksTick({ dispatch: async () => completingChat(calls) });
  assert.equal(result.claimed, 1);
  assert.equal(result.deferred, 1);
  assert.equal(calls.length, 1);
  assert.equal((await prisma.scheduledTaskRun.findFirstOrThrow()).taskId, first.id);
  // Still due, and taken once the first run has released the slot.
  const next = await runScheduledTasksTick({ dispatch: async () => completingChat(calls) });
  assert.equal(next.claimed, 1);
  assert.equal(calls.length, 2);
  assert.equal(await prisma.scheduledTaskRun.count({ where: { taskId: second.id, status: "succeeded" } }), 1);
});

test("the one-in-flight slot is a database rule, not a convention", async () => {
  const userId = await seedUser();
  const a = await seedTask(userId);
  const b = await seedTask(userId, { title: "Other" });
  const row = (taskId: string) => ({
    id: randomUUID(), taskId, userId, runningUserId: userId, scheduledFor: new Date(),
    assistantMessageId: randomUUID(), leaseExpiresAt: new Date(Date.now() + 60_000),
  });
  await prisma.scheduledTaskRun.create({ data: row(a.id) });
  await assert.rejects(prisma.scheduledTaskRun.create({ data: row(b.id) }), /Unique constraint/);
  // A running row must hold the slot, and only for its own account.
  await assert.rejects(prisma.$executeRawUnsafe(
    `INSERT INTO "ScheduledTaskRun" ("id","taskId","userId","runningUserId","scheduledFor","status","assistantMessageId","leaseExpiresAt")
     VALUES ('${randomUUID()}','${b.id}','${userId}',NULL,NOW(),'running','${randomUUID()}',NOW())`), /ScheduledTaskRun_running_shape_check/);
  await assert.rejects(prisma.$executeRawUnsafe(
    `UPDATE "ScheduledTask" SET "frequency" = 'hourly' WHERE "id" = '${a.id}'`), /ScheduledTask_frequency_check/);
  await assert.rejects(prisma.$executeRawUnsafe(
    `UPDATE "ScheduledTask" SET "status" = 'paused' WHERE "id" = '${a.id}'`), /ScheduledTask_pause_shape_check/);
});

test("with the account busy in Chat the run waits for a free slot instead of taking its last one", async () => {
  await enable();
  const userId = await seedUser();
  await seedTask(userId);
  const { identifyChatCaller } = await import("@/lib/chatSecurity");
  const subjectKey = identifyChatCaller(new Request("https://scheduled-task.invalid/"), userId).subjectKey;
  for (let index = 0; index < 49; index += 1) {
    await prisma.chatRequestLease.create({
      data: { id: randomUUID(), subjectKey, claimedAt: new Date(), expiresAt: new Date(Date.now() + 120_000) },
    });
  }
  const result = await runScheduledTasksTick({ dispatch: async () => neverCalled() });
  assert.equal(result.claimed, 0);
  assert.equal(result.deferred, 1);
  assert.equal(await prisma.scheduledTaskRun.count(), 0);
});

test("a refusal for credits pauses the task and records why; nothing is retried", async () => {
  await enable();
  const userId = await seedUser();
  const task = await seedTask(userId);
  const calls: Call[] = [];
  await runScheduledTasksTick({ dispatch: async () => refusingChat(402, "CREDIT_BALANCE_INSUFFICIENT", calls) });
  assert.equal(calls.length, 1);
  const run = await prisma.scheduledTaskRun.findFirstOrThrow({ where: { taskId: task.id } });
  assert.equal(run.status, "skipped");
  assert.equal(run.outcome, "CREDIT_BALANCE_INSUFFICIENT");
  const paused = await prisma.scheduledTask.findUniqueOrThrow({ where: { id: task.id } });
  assert.equal(paused.status, "paused");
  assert.equal(paused.pauseReason, "insufficient_credits");
  assert.equal(paused.nextRunAt, null);
  assert.equal(paused.consecutiveFailures, 0);
});

test("a run that would reserve more than approved is refused inside the reservation and pauses the task", async () => {
  await enable();
  const userId = await seedUser();
  const task = await seedTask(userId);
  const calls: Call[] = [];
  await runScheduledTasksTick({ dispatch: async () => completingChat(calls, task.creditsPerRun + 1) });
  const run = await prisma.scheduledTaskRun.findFirstOrThrow({ where: { taskId: task.id } });
  assert.equal(run.status, "skipped");
  assert.equal(run.outcome, "SCHEDULED_TASK_CREDIT_CAP_EXCEEDED");
  assert.equal(run.reservedCredits, 0);
  assert.equal(run.chatReservationId, null);
  assert.equal(await prisma.chatResponseAttempt.count(), 0);
  const paused = await prisma.scheduledTask.findUniqueOrThrow({ where: { id: task.id } });
  assert.equal(paused.pauseReason, "cost_changed");
});

test("the reservation guard is cumulative over a run and absent outside one", async () => {
  const userId = await seedUser();
  const task = await seedTask(userId, { creditsPerRun: 5 });
  const runId = randomUUID();
  await prisma.scheduledTaskRun.create({
    data: { id: runId, taskId: task.id, userId, runningUserId: userId, scheduledFor: new Date(),
      assistantMessageId: scheduledRunAssistantMessageId(runId), leaseExpiresAt: new Date(Date.now() + 60_000) },
  });
  assert.equal(scheduledTaskReservationGuard(userId), undefined);
  const request = new Request("https://scheduled-task.invalid/api/chat", { method: "POST" });
  const session = { user: { id: userId }, expires: new Date(Date.now() + 60_000).toISOString() };
  await runAsScheduledTask({ runId, userId, session, request, creditCeiling: 5 }, async () => {
    assert.equal(scheduledTaskRunSession(request)?.user?.id, userId);
    assert.equal(scheduledTaskRunSession(new Request("https://scheduled-task.invalid/api/chat")), null);
    const guard = scheduledTaskReservationGuard(userId)!;
    await prisma.$transaction((tx) => guard(tx, { reservationId: "first", usageCredits: 3 }));
    await assert.rejects(prisma.$transaction((tx) => guard(tx, { reservationId: "second", usageCredits: 3 })),
      (error: { code?: string }) => error.code === "SCHEDULED_TASK_CREDIT_CAP_EXCEEDED");
    await prisma.$transaction((tx) => guard(tx, { reservationId: "third", usageCredits: 2 }));
    await assert.rejects(prisma.$transaction((tx) => scheduledTaskReservationGuard("someone-else")!(tx, { reservationId: "x", usageCredits: 0 })),
      (error: { code?: string }) => error.code === "SCHEDULED_TASK_SCOPE_MISMATCH");
  });
  const run = await prisma.scheduledTaskRun.findUniqueOrThrow({ where: { id: runId } });
  assert.equal(run.reservedCredits, 5);
  assert.equal(run.chatReservationId, "first");
  assert.equal(scheduledTaskRunSession(request), null);
});

test("three failed runs in a row pause the task", async () => {
  await enable();
  const userId = await seedUser();
  const task = await seedTask(userId);
  for (let index = 0; index < SCHEDULED_TASK_LIMITS.maxConsecutiveFailures; index += 1) {
    // Earlier runs move two days back, so the interval guard never interferes.
    await prisma.$executeRaw`UPDATE "ScheduledTaskRun" SET "scheduledFor" = "scheduledFor" - interval '2 days' WHERE "taskId" = ${task.id}`;
    await prisma.scheduledTask.update({ where: { id: task.id }, data: { nextRunAt: new Date(Date.now() - 60_000) } });
    await runScheduledTasksTick({ dispatch: async () => refusingChat(500, "MODEL_TEMPORARILY_UNAVAILABLE") });
  }
  const runs = await prisma.scheduledTaskRun.findMany({ where: { taskId: task.id } });
  assert.equal(runs.length, SCHEDULED_TASK_LIMITS.maxConsecutiveFailures);
  assert.ok(runs.every((run) => run.status === "failed"));
  const paused = await prisma.scheduledTask.findUniqueOrThrow({ where: { id: task.id } });
  assert.equal(paused.status, "paused");
  assert.equal(paused.pauseReason, "repeated_failures");
});

test("an occurrence missed by more than the grace window is skipped, never fired late", async () => {
  await enable();
  const userId = await seedUser();
  const task = await seedTask(userId, { nextRunAt: new Date(Date.now() - SCHEDULED_TASK_LIMITS.lateGraceMs - 60_000) });
  const result = await runScheduledTasksTick({ dispatch: async () => neverCalled() });
  assert.equal(result.skippedLate, 1);
  assert.equal(await prisma.scheduledTaskRun.count(), 0);
  const moved = await prisma.scheduledTask.findUniqueOrThrow({ where: { id: task.id } });
  assert.ok(moved.nextRunAt && moved.nextRunAt.getTime() > Date.now());
});

test("a run whose lease lapsed is settled from its attempt and never sent again", async () => {
  const userId = await seedUser();
  const task = await seedTask(userId);
  const conversation = await prisma.conversation.create({
    data: { userId, title: "Morning news", productKey: "chat", kind: "chat", selectedModels: JSON.stringify([MODEL_ID]) },
  });
  const question = await prisma.message.create({ data: { conversationId: conversation.id, role: "user", content: task.prompt } });
  const lapsed = async (attemptStatus: "streaming" | null, reservation: string | null) => {
    const runId = randomUUID();
    const scheduledFor = new Date(Date.now() - Math.floor(Math.random() * 1e9));
    await prisma.scheduledTaskRun.create({
      data: { id: runId, taskId: task.id, userId, runningUserId: userId, scheduledFor, conversationId: conversation.id,
        userMessageId: question.id, assistantMessageId: scheduledRunAssistantMessageId(runId), chatReservationId: reservation,
        leaseExpiresAt: new Date(Date.now() - 1_000) },
    });
    if (attemptStatus) {
      const assistantMessageId = scheduledRunAssistantMessageId(runId);
      await prisma.chatResponseAttempt.create({
        data: { assistantMessageId, userId, conversationId: conversation.id,
          sourceUserMessageId: question.id, fingerprint: FINGERPRINT, requestedModelId: MODEL_ID, status: attemptStatus,
          ownerId: "dead-worker", leaseExpiresAt: new Date(Date.now() + 60_000) },
      });
      // A worker that died ten minutes ago: its last write and its lease are both in the past.
      await prisma.$executeRaw`
        UPDATE "ChatResponseAttempt"
        SET "updatedAt" = NOW() - interval '10 minutes', "leaseExpiresAt" = NOW() - interval '9 minutes'
        WHERE "assistantMessageId" = ${assistantMessageId}`;
    }
    await reconcileExpiredScheduledRuns(new Date());
    return prisma.scheduledTaskRun.findUniqueOrThrow({ where: { id: runId } });
  };
  const unknown = await lapsed("streaming", "held-reservation");
  assert.equal(unknown.status, "unknown");
  assert.equal(unknown.outcome, "outcome_unknown");
  assert.equal(unknown.runningUserId, null);
  const interrupted = await lapsed(null, null);
  assert.equal(interrupted.status, "failed");
  assert.equal(interrupted.outcome, "interrupted");
  const settled = await prisma.scheduledTask.findUniqueOrThrow({ where: { id: task.id } });
  assert.equal(settled.consecutiveFailures, 2);
});

test("a plan without scheduled tasks is skipped and paused before anything is written to Chat", async () => {
  await enable();
  const userId = await seedUser("Pro");
  const task = await seedTask(userId);
  await prisma.user.update({ where: { id: userId }, data: { plan: "Free" } });
  await runScheduledTasksTick({ dispatch: async () => neverCalled() });
  const run = await prisma.scheduledTaskRun.findFirstOrThrow({ where: { taskId: task.id } });
  assert.equal(run.status, "skipped");
  assert.equal(run.outcome, "plan_required");
  assert.equal(await prisma.message.count(), 0);
  assert.equal((await prisma.scheduledTask.findUniqueOrThrow({ where: { id: task.id } })).pauseReason, "plan_required");
});

test("the account export carries the tasks and runs, and deleting the account deletes them", async () => {
  await enable();
  const userId = await seedUser();
  await seedTask(userId);
  await runScheduledTasksTick({ dispatch: async () => completingChat([]) });
  const exported = await buildAccountDataExport(userId);
  const text = JSON.stringify(exported);
  assert.ok(text.includes("scheduled_tasks"), "scheduled_tasks domain is exported");
  assert.ok(text.includes("scheduled_task_runs"), "scheduled_task_runs domain is exported");
  assert.ok(text.includes("Summarise today's AI news."));
  assert.equal(text.includes("runningUserId"), false);
  assert.equal(text.includes("chatReservationId"), false);
  await prisma.user.delete({ where: { id: userId } });
  assert.equal(await prisma.scheduledTask.count(), 0);
  assert.equal(await prisma.scheduledTaskRun.count(), 0);
});
