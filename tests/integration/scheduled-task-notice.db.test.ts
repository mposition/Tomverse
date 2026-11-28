import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, mock, test } from "node:test";

import {
  SCHEDULED_TASK_PAUSED_TEMPLATE,
  SCHEDULED_TASK_RUN_ANSWERED_TEMPLATE,
} from "@/lib/emailTemplateDefinitions";
import { prisma } from "@/lib/prisma";
import { SCHEDULED_TASKS_FLAG_KEY } from "@/lib/scheduledTaskAccess";
import { queueScheduledRunNotice } from "@/lib/scheduledTaskNotice";
import { scheduledTaskReservationGuard } from "@/lib/scheduledTaskReservationGuard";
import { scheduledTaskRunSession } from "@/lib/scheduledTaskRunContext";
import { runScheduledTasksTick, type ChatDispatch } from "@/lib/scheduledTaskRunner";
import { quoteScheduledRunCredits } from "@/lib/scheduledTaskService";
import { drainStandardEmailDeliveries } from "@/lib/standardEmailLane";

/**
 * Scheduled-task result emails against a real database
 * (lib/scheduledTaskNotice.ts, docs/policy/email-notifications.md §3.2, 4a).
 *
 * What is owed is one queued message per finished run -- an answer, or the
 * pause the run caused -- and nothing when the switch, the task's own toggle or
 * the account's `scheduled_tasks` purpose says no. The Chat route is replaced by
 * the same durable-path fakes the scheduled-task suite uses; the email
 * provider is a stubbed `fetch`, never a live send.
 */

const MODEL_ID = "gpt-6-luna";
const PROMPT = "Summarise today's AI news.";

const reset = async () => {
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "EmailDelivery", "EmailEvent", "TemplateVersion", "EmailTemplate", "EmailPolicyVersion",
      "ScheduledTaskRun", "ScheduledTask", "ChatResponseAttempt", "ChatRequestLease",
      "Message", "Conversation", "UserSettings", "User"
    RESTART IDENTITY CASCADE
  `);
  await prisma.appSetting.deleteMany({ where: { key: SCHEDULED_TASKS_FLAG_KEY } });
};

beforeEach(async () => {
  await reset();
  mock.restoreAll();
  delete process.env.SCHEDULED_TASK_EMAIL_ENABLED;
  process.env.EMAIL_AUDIT_HASH_KEY = "test-audit-key";
  process.env.EMAIL_SNAPSHOT_KEYS = "v1:test-snapshot-key";
  process.env.EMAIL_SNAPSHOT_KEY_VERSION = "v1";
  process.env.RESEND_API_KEY = "test-key";
  await prisma.appSetting.upsert({
    where: { key: SCHEDULED_TASKS_FLAG_KEY },
    update: { value: "true" },
    create: { key: SCHEDULED_TASKS_FLAG_KEY, value: "true" },
  });
});

after(async () => {
  mock.restoreAll();
  delete process.env.SCHEDULED_TASK_EMAIL_ENABLED;
  await reset();
  await prisma.$disconnect();
});

const switchOn = () => {
  process.env.SCHEDULED_TASK_EMAIL_ENABLED = "true";
};

async function seedUser() {
  const id = randomUUID();
  await prisma.user.create({ data: { id, email: `${id}@example.invalid`, plan: "Pro" } });
  await prisma.userSettings.create({ data: { userId: id, defaultModel: MODEL_ID, timeZone: "UTC", language: "ko" } });
  return id;
}

async function seedTask(userId: string, overrides: Record<string, unknown> = {}) {
  const creditsPerRun = await quoteScheduledRunCredits({ userId, modelId: MODEL_ID, prompt: PROMPT, webSearch: false });
  return prisma.scheduledTask.create({
    data: {
      userId,
      title: "Morning news",
      prompt: PROMPT,
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

/** The Chat route's durable path, as in tests/integration/scheduled-tasks.db.test.ts. */
const completingChat = (): ChatDispatch => async (request) => {
  const session = scheduledTaskRunSession(request);
  const body = (await request.json()) as Record<string, string>;
  const guard = scheduledTaskReservationGuard(session!.user!.id);
  await prisma.$transaction((tx) => guard!(tx, { reservationId: randomUUID(), usageCredits: 1 }));
  await prisma.chatResponseAttempt.create({
    data: {
      assistantMessageId: body.assistantMessageId,
      userId: session!.user!.id,
      conversationId: body.conversationId,
      sourceUserMessageId: body.sourceUserMessageId,
      fingerprint: "a".repeat(64),
      requestedModelId: body.modelId,
      status: "completed",
      ownerId: "fake-owner",
      leaseExpiresAt: new Date(Date.now() + 60_000),
      finishReason: "stop",
      terminalAt: new Date(),
    },
  });
  return new Response("the private answer text", { status: 200 });
};

const refusingChat = (status: number, code: string): ChatDispatch => async (request) => {
  await request.json();
  return Response.json({ code }, { status });
};

const deliveries = () =>
  prisma.emailDelivery.findMany({ include: { templateVersion: { include: { template: true } }, event: true } });

test("with the email switch off a finished run queues nothing", async () => {
  const userId = await seedUser();
  await seedTask(userId);
  for (const value of [undefined, "false", "TRUE", "1"]) {
    if (value === undefined) delete process.env.SCHEDULED_TASK_EMAIL_ENABLED;
    else process.env.SCHEDULED_TASK_EMAIL_ENABLED = value;
    const run = await prisma.scheduledTaskRun.findFirst();
    if (run) assert.equal(await queueScheduledRunNotice({ runId: run.id, kind: "answered" }), "switch_off", String(value));
    else await runScheduledTasksTick({ dispatch: async () => completingChat() });
  }
  const run = await prisma.scheduledTaskRun.findFirstOrThrow();
  assert.equal(run.status, "succeeded");
  assert.equal(run.noticeQueuedAt, null);
  assert.equal(await prisma.emailDelivery.count(), 0);
  assert.equal(await prisma.emailEvent.count(), 0);
});

test("an answered run queues one notice, and the drain sends status and links but no answer", async () => {
  switchOn();
  const userId = await seedUser();
  const task = await seedTask(userId);
  await runScheduledTasksTick({ dispatch: async () => completingChat() });

  const run = await prisma.scheduledTaskRun.findFirstOrThrow();
  assert.equal(run.status, "succeeded");
  assert.ok(run.noticeQueuedAt, "the run is marked as notified");
  const queued = await deliveries();
  assert.equal(queued.length, 1);
  assert.equal(queued[0].templateVersion.template.key, SCHEDULED_TASK_RUN_ANSWERED_TEMPLATE);
  assert.equal(queued[0].event.referenceType, "scheduled_task_run");
  assert.equal(queued[0].event.referenceId, run.id);
  assert.equal(queued[0].language, "ko");

  // Asked again -- a retried finish, a reconciliation -- it queues nothing.
  assert.equal(await queueScheduledRunNotice({ runId: run.id, kind: "answered" }), "already_queued");
  assert.equal(await prisma.emailDelivery.count(), 1);

  const sent: Array<Record<string, unknown>> = [];
  mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ id: `resend-${randomUUID()}` }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  const drained = await drainStandardEmailDeliveries();
  assert.equal(drained.sent, 1);
  assert.equal(sent.length, 1);
  const message = JSON.stringify(sent[0]);
  assert.match(String(sent[0].subject), /Morning news/);
  const conversationId = (await prisma.scheduledTask.findUniqueOrThrow({ where: { id: task.id } })).conversationId;
  assert.ok(conversationId && message.includes(encodeURIComponent(conversationId)), "links to the answer's conversation");
  assert.ok(message.includes("/settings/notifications"), "says where to switch it off");
  assert.ok(!message.includes("the private answer text"), "no answer text");
  assert.ok(!message.includes(PROMPT), "no question text");
  // A second drain sends nothing more.
  assert.equal((await drainStandardEmailDeliveries()).sent, 0);
  assert.equal(sent.length, 1);
});

test("a run that pauses the task queues the paused notice; a failure that will be retried queues none", async () => {
  switchOn();
  const pausedUser = await seedUser();
  await seedTask(pausedUser);
  await runScheduledTasksTick({ dispatch: async () => refusingChat(402, "CREDIT_BALANCE_INSUFFICIENT") });
  const pausedTask = await prisma.scheduledTask.findFirstOrThrow({ where: { userId: pausedUser } });
  assert.equal(pausedTask.status, "paused");
  const paused = await deliveries();
  assert.equal(paused.length, 1);
  assert.equal(paused[0].templateVersion.template.key, SCHEDULED_TASK_PAUSED_TEMPLATE);

  const failingUser = await seedUser();
  await seedTask(failingUser);
  await runScheduledTasksTick({ dispatch: async () => refusingChat(500, "UPSTREAM_BROKE") });
  const failed = await prisma.scheduledTaskRun.findFirstOrThrow({ where: { userId: failingUser } });
  assert.equal(failed.status, "failed");
  assert.equal((await prisma.scheduledTask.findFirstOrThrow({ where: { userId: failingUser } })).status, "active");
  assert.equal(failed.noticeQueuedAt, null);
  assert.equal(await prisma.emailDelivery.count(), 1, "only the pause was notified");
});

test("the task's own switch and the account's email purpose each queue nothing", async () => {
  switchOn();
  const taskOffUser = await seedUser();
  await seedTask(taskOffUser, { emailOnFinish: false });
  const purposeOffUser = await seedUser();
  await seedTask(purposeOffUser);
  await prisma.emailPreference.create({
    data: { userId: purposeOffUser, purpose: "scheduled_tasks", enabled: false, source: "preference_center" },
  });

  await runScheduledTasksTick({ dispatch: async () => completingChat() });
  await runScheduledTasksTick({ dispatch: async () => completingChat() });

  const runs = await prisma.scheduledTaskRun.findMany({ orderBy: { userId: "asc" } });
  assert.equal(runs.length, 2);
  assert.ok(runs.every((run) => run.status === "succeeded" && run.noticeQueuedAt === null));
  assert.equal(await prisma.emailDelivery.count(), 0);
  const taskOffRun = runs.find((run) => run.userId === taskOffUser)!;
  const purposeOffRun = runs.find((run) => run.userId === purposeOffUser)!;
  assert.equal(await queueScheduledRunNotice({ runId: taskOffRun.id, kind: "answered" }), "task_off");
  assert.equal(await queueScheduledRunNotice({ runId: purposeOffRun.id, kind: "answered" }), "preference_off");
});

test("retried and concurrent queueing of one run writes one notice", async () => {
  switchOn();
  const userId = await seedUser();
  const task = await seedTask(userId);
  const run = await prisma.scheduledTaskRun.create({
    data: {
      taskId: task.id,
      userId,
      taskRevision: task.revision,
      scheduledFor: new Date(Date.now() - 60_000),
      status: "succeeded",
      outcome: "completed",
      assistantMessageId: randomUUID(),
      leaseExpiresAt: new Date(),
      finishedAt: new Date(),
    },
  });

  const outcomes = await Promise.all(
    Array.from({ length: 4 }, () => queueScheduledRunNotice({ runId: run.id, kind: "answered" }))
  );
  assert.equal(outcomes.filter((outcome) => outcome === "queued").length, 1, outcomes.join(","));
  assert.ok(outcomes.every((outcome) => outcome === "queued" || outcome === "already_queued"), outcomes.join(","));
  assert.equal(await queueScheduledRunNotice({ runId: run.id, kind: "paused" }), "already_queued");
  assert.equal(await prisma.emailDelivery.count(), 1);
  assert.equal(await prisma.emailEvent.count(), 1);
});
