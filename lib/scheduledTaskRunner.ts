import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import type { Session } from "next-auth";

import { ApiSecurityError, assertMessageCapacity } from "@/lib/apiSecurity";
import { resolveChatConcurrencyPlan } from "@/lib/chatConcurrencyCore";
import { identifyChatCaller } from "@/lib/chatSecurity";
import { createConversation } from "@/lib/conversationCreation";
import { scopedMessageId } from "@/lib/messageRequestIdentity";
import { getRuntimeModels } from "@/lib/modelRegistry";
import { isPubliclySelectableModel } from "@/lib/models";
import { prisma } from "@/lib/prisma";
import { getPublicAppOrigin } from "@/lib/publicUrl";
import {
  classifyAttempt,
  classifyChatRefusal,
  decideDueOccurrence,
  failureStreakAfter,
  nextOccurrence,
  planRunsScheduledTasks,
  SCHEDULED_TASK_LIMITS,
  type RunClassification,
  type ScheduledTaskSchedule,
} from "@/lib/scheduledTaskCore";
import { runAsScheduledTask } from "@/lib/scheduledTaskRunContext";
import { isScheduledTasksEnabled } from "@/lib/scheduledTaskSettings";
import { getUserBillingPlan } from "@/lib/billingEntitlements";
import { quoteScheduledRunCredits, ScheduledTaskError } from "@/lib/scheduledTaskService";

/**
 * The scheduled-task runner, one pass per maintenance tick (every 15 minutes,
 * from /api/internal/maintenance/credit-reservations).
 *
 * Order matters and each step is idempotent:
 *
 *   1. With `feature.scheduledTasksEnabled` off nothing is read or written --
 *      not even reconciliation. Off means no scheduled work exists.
 *   2. Runs whose lease lapsed are settled from the Chat attempt they left. A
 *      run whose answer cannot be confirmed becomes `unknown` and is never sent
 *      again.
 *   3. Due tasks are claimed one per transaction under `FOR UPDATE SKIP
 *      LOCKED`. The run row's (taskId, scheduledFor) and runningUserId unique
 *      keys are what make a double claim impossible rather than unlikely.
 *   4. Each claimed run is one ordinary Chat turn through the Chat route's own
 *      handler (`dispatch`), as the account, inside the run scope that also
 *      carries the credit ceiling the reservation guard enforces.
 */

export type ChatDispatch = (request: Request) => Promise<Response>;

export type ScheduledTaskTickResult = {
  enabled: boolean;
  reconciled: number;
  claimed: number;
  skippedLate: number;
  deferred: number;
  executed: Record<string, number>;
};

const DISPATCH_TIMEOUT_MS = 10 * 60 * 1_000;

/** A UUID (RFC 9562 v8 slot) derived from the run, so the same run always names the same messages. */
const derivedUuid = (namespace: string, runId: string) => {
  const digest = createHash("sha256").update(`${namespace}\0${runId}`, "utf8").digest().subarray(0, 16);
  digest[6] = (digest[6]! & 0x0f) | 0x80;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const value = digest.toString("hex");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
};
export const scheduledRunAssistantMessageId = (runId: string) => derivedUuid("tomverse:scheduled-task-answer:v1", runId);
export const scheduledRunQuestionRequestId = (runId: string) => derivedUuid("tomverse:scheduled-task-question:v1", runId);

const scheduleOf = (task: {
  frequency: string; timeOfDay: string; dayOfWeek: number | null; dayOfMonth: number | null; runOnDate: string | null; timeZone: string;
}): ScheduledTaskSchedule => ({
  frequency: task.frequency as ScheduledTaskSchedule["frequency"],
  timeOfDay: task.timeOfDay,
  dayOfWeek: task.dayOfWeek,
  dayOfMonth: task.dayOfMonth,
  runOnDate: task.runOnDate,
  timeZone: task.timeZone,
});

/* ----------------------------------------------------------- finalising -- */

/**
 * Closes a run and applies its consequence to the task, in one transaction.
 * Conditional on the run still being `running`, so a reconciliation and a
 * finishing worker cannot both apply a result.
 */
async function finalizeRun(
  run: { id: string; taskId: string; userId: string },
  classification: RunClassification,
  extra: { chargedCredits?: number | null; conversationId?: string | null } = {}
) {
  await prisma.$transaction(async (tx) => {
    const closed = await tx.scheduledTaskRun.updateMany({
      where: { id: run.id, status: "running" },
      data: {
        status: classification.status,
        outcome: classification.outcome,
        runningUserId: null,
        finishedAt: new Date(),
        ...(extra.chargedCredits !== undefined ? { chargedCredits: extra.chargedCredits } : {}),
      },
    });
    if (!closed.count) return;
    const task = await tx.scheduledTask.findUnique({
      where: { id: run.taskId },
      select: { status: true, frequency: true, consecutiveFailures: true },
    });
    if (!task) return;
    const streak = failureStreakAfter(task.consecutiveFailures, classification);
    // A person's own pause (or a delete) during the run wins over the run's verdict.
    const stillActive = task.status === "active";
    const pause = stillActive ? streak.pause : null;
    await tx.scheduledTask.update({
      where: { id: run.taskId },
      data: {
        consecutiveFailures: streak.consecutiveFailures,
        ...(pause
          ? { status: "paused", pauseReason: pause, nextRunAt: null }
          : stillActive && task.frequency === "once"
            ? { status: "completed", nextRunAt: null }
            : {}),
      },
    });
    // The sidebar is ordered by updatedAt: a fresh answer moves its
    // conversation to the top, which is the whole of the notification.
    if (classification.status === "succeeded" && extra.conversationId) {
      await tx.conversation.updateMany({
        where: { id: extra.conversationId, userId: run.userId },
        data: { updatedAt: new Date() },
      });
    }
  });
}

const chargedCreditsOf = async (chatReservationId: string | null) => {
  if (!chatReservationId) return null;
  const reservation = await prisma.chatCreditReservation.findUnique({
    where: { id: chatReservationId },
    select: { settledAt: true, settledCredits: true },
  });
  return reservation?.settledAt ? reservation.settledCredits : null;
};

/* -------------------------------------------------------- reconciliation -- */

/** Runs whose lease lapsed: settled from the durable attempt, never re-sent. */
export async function reconcileExpiredScheduledRuns(now = new Date()) {
  const stale = await prisma.scheduledTaskRun.findMany({
    where: { status: "running", leaseExpiresAt: { lt: now } },
    orderBy: { leaseExpiresAt: "asc" },
    take: 100,
    select: { id: true, taskId: true, userId: true, assistantMessageId: true, conversationId: true, chatReservationId: true },
  });
  let reconciled = 0;
  for (const run of stale) {
    const attempt = await prisma.chatResponseAttempt.findFirst({
      where: { assistantMessageId: run.assistantMessageId, userId: run.userId },
      select: { status: true, failureCode: true, leaseExpiresAt: true },
    });
    // No attempt and no reservation: the run died before the Chat route
    // claimed anything, so nothing was sent and nothing was charged.
    const classification = !attempt && !run.chatReservationId
      ? ({ status: "failed", outcome: "interrupted", pause: null } as const)
      : classifyAttempt(attempt, now);
    if (!classification) continue;
    await finalizeRun(run, classification, {
      chargedCredits: await chargedCreditsOf(run.chatReservationId),
      conversationId: run.conversationId,
    });
    reconciled += 1;
  }
  return reconciled;
}

/* ---------------------------------------------------------------- claim -- */

type ClaimedRun = { id: string; taskId: string; userId: string; assistantMessageId: string };

const accountSubjectKey = (userId: string) =>
  identifyChatCaller(new Request("https://scheduled-task.invalid/"), userId).subjectKey;

/** The account's own Chat in flight leaves at least one slot free for it. */
const accountChatBusy = async (tx: Prisma.TransactionClient, userId: string) => {
  const access = identifyChatCaller(new Request("https://scheduled-task.invalid/"), userId);
  const limit = resolveChatConcurrencyPlan({ kind: "user", subjectKey: access.subjectKey, ipKey: access.ipKey }).subject.limit;
  const rows = await tx.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(*)::bigint AS "count" FROM "ChatRequestLease"
    WHERE "subjectKey" = ${accountSubjectKey(userId)} AND "expiresAt" > NOW()`;
  return Number(rows[0]?.count ?? 0) >= Math.max(1, limit - 1);
};

type ClaimOutcome = { kind: "claimed"; run: ClaimedRun } | { kind: "late" } | { kind: "deferred" } | { kind: "none" };

async function claimTask(taskId: string, now: Date): Promise<ClaimOutcome> {
  try {
    return await prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{
        id: string; userId: string; nextRunAt: Date; frequency: string; timeOfDay: string;
        dayOfWeek: number | null; dayOfMonth: number | null; runOnDate: string | null; timeZone: string;
      }>>`
        SELECT "id", "userId", "nextRunAt", "frequency", "timeOfDay", "dayOfWeek", "dayOfMonth", "runOnDate", "timeZone"
        FROM "ScheduledTask"
        WHERE "id" = ${taskId} AND "status" = 'active' AND "nextRunAt" IS NOT NULL AND "nextRunAt" <= ${now}
        FOR UPDATE SKIP LOCKED`;
      const task = rows[0];
      if (!task) return { kind: "none" } as const;
      const schedule = scheduleOf(task);
      const previous = await tx.scheduledTaskRun.findFirst({
        where: { taskId, scheduledFor: { lt: task.nextRunAt } },
        orderBy: { scheduledFor: "desc" },
        select: { scheduledFor: true },
      });
      const decision = decideDueOccurrence({
        schedule,
        dueAt: task.nextRunAt,
        now,
        previousScheduledFor: previous?.scheduledFor ?? null,
      });
      if (decision.kind !== "run") {
        await tx.scheduledTask.update({
          where: { id: taskId },
          data: decision.next ? { nextRunAt: decision.next } : { nextRunAt: null, status: "completed" },
        });
        return { kind: "late" } as const;
      }
      if (await tx.scheduledTaskRun.findUnique({ where: { runningUserId: task.userId }, select: { id: true } })) {
        return { kind: "deferred" } as const;
      }
      if (await accountChatBusy(tx, task.userId)) return { kind: "deferred" } as const;
      const runId = randomUUID();
      const run = await tx.scheduledTaskRun.create({
        data: {
          id: runId,
          taskId,
          userId: task.userId,
          runningUserId: task.userId,
          scheduledFor: decision.scheduledFor,
          assistantMessageId: scheduledRunAssistantMessageId(runId),
          leaseExpiresAt: new Date(now.getTime() + SCHEDULED_TASK_LIMITS.runLeaseMs),
        },
        select: { id: true, taskId: true, userId: true, assistantMessageId: true },
      });
      await tx.scheduledTask.update({
        where: { id: taskId },
        data: { nextRunAt: nextOccurrence(schedule, now) },
      });
      return { kind: "claimed", run } as const;
    });
  } catch (error) {
    // Another tick claimed this occurrence, or this account's one slot, first.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return { kind: "deferred" };
    throw error;
  }
}

/* -------------------------------------------------------------- execute -- */

const drain = async (response: Response, timeoutMs: number) => {
  if (!response.body) return;
  const reader = response.body.getReader();
  const deadline = Date.now() + timeoutMs;
  try {
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        await reader.cancel().catch(() => undefined);
        return;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const result = await Promise.race([
        reader.read(),
        new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), remaining);
        }),
      ]).finally(() => clearTimeout(timer));
      if (result === "timeout") {
        await reader.cancel().catch(() => undefined);
        return;
      }
      if (result.done) return;
    }
  } finally {
    reader.releaseLock();
  }
};

const readRefusalCode = async (response: Response) => {
  try {
    const body = (await response.json()) as { code?: unknown } | null;
    return body?.code;
  } catch {
    return undefined;
  }
};

type Prepared =
  | { kind: "ready"; conversationId: string; userMessageId: string; questionRequestId: string }
  | { kind: "skip"; classification: RunClassification };

/**
 * The dedicated conversation and this run's question, saved the way the
 * message endpoint saves a browser's question: under the account's message
 * capacity lock and with the conversation-scoped Message id.
 */
async function prepareConversation(
  run: ClaimedRun,
  task: { id: string; title: string; prompt: string; modelId: string; webSearch: boolean; conversationId: string | null }
): Promise<Prepared> {
  const questionRequestId = scheduledRunQuestionRequestId(run.id);
  try {
    return await prisma.$transaction(async (tx) => {
      let conversationId: string | null = null;
      if (task.conversationId) {
        const existing = await tx.conversation.findFirst({
          where: { id: task.conversationId, userId: run.userId },
          select: { id: true, kind: true, productKey: true, password: true, selectedModels: true },
        });
        if (existing && existing.password !== null) {
          return { kind: "skip", classification: { status: "skipped", outcome: "conversation_locked", pause: "conversation_locked" } } as const;
        }
        if (existing && existing.kind === "chat" && existing.productKey === "chat") {
          conversationId = existing.id;
          // The Chat route answers only with a model the conversation has selected.
          let selected: unknown = null;
          try { selected = JSON.parse(existing.selectedModels); } catch { selected = null; }
          if (!Array.isArray(selected) || !selected.includes(task.modelId)) {
            await tx.conversation.update({ where: { id: existing.id }, data: { selectedModels: JSON.stringify([task.modelId]) } });
          }
        }
      }
      if (!conversationId) {
        const created = await createConversation(tx, {
          userId: run.userId,
          title: task.title,
          productKey: "chat",
          selectedModels: JSON.stringify([task.modelId]),
          webSearchMode: task.webSearch ? "always" : "off",
        }, { id: true });
        conversationId = created.id;
        await tx.scheduledTask.updateMany({ where: { id: task.id, userId: run.userId }, data: { conversationId } });
      }
      await assertMessageCapacity(tx, run.userId, conversationId, 1, Buffer.byteLength(task.prompt, "utf8"));
      const userMessageId = scopedMessageId(conversationId, questionRequestId);
      await tx.message.createMany({
        data: [{ id: userMessageId, conversationId, role: "user", content: task.prompt, status: "normal" }],
        skipDuplicates: true,
      });
      await tx.scheduledTaskRun.updateMany({
        where: { id: run.id, status: "running" },
        data: { conversationId, userMessageId },
      });
      return { kind: "ready", conversationId, userMessageId, questionRequestId } as const;
    });
  } catch (error) {
    if (error instanceof ApiSecurityError) {
      return { kind: "skip", classification: { status: "skipped", outcome: error.code, pause: "storage_full" } };
    }
    throw error;
  }
}

/** Why this run may not spend at all, decided before anything is written. */
async function eligibility(task: {
  userId: string; modelId: string; prompt: string; webSearch: boolean; creditsPerRun: number;
}, account: { accountStatus: string; accountDeletionRequestedAt: Date | null }): Promise<RunClassification | null> {
  if (account.accountStatus !== "active" || account.accountDeletionRequestedAt) {
    return { status: "skipped", outcome: "account_unavailable", pause: "account_unavailable" };
  }
  const plan = await getUserBillingPlan(task.userId);
  if (!planRunsScheduledTasks(plan.tier)) return { status: "skipped", outcome: "plan_required", pause: "plan_required" };
  const model = (await getRuntimeModels()).find((candidate) => candidate.id === task.modelId);
  if (!model || !isPubliclySelectableModel(model) || model.usageClass === "deep-research") {
    return { status: "skipped", outcome: "model_unavailable", pause: "model_unavailable" };
  }
  // A cheap early answer; the reservation guard is the boundary.
  try {
    const quoted = await quoteScheduledRunCredits(task);
    if (quoted > task.creditsPerRun) return { status: "skipped", outcome: "cost_changed", pause: "cost_changed" };
  } catch (error) {
    if (error instanceof ScheduledTaskError) {
      return error.code === "WEB_SEARCH_UNAVAILABLE"
        ? { status: "skipped", outcome: "web_search_unavailable", pause: null }
        : { status: "skipped", outcome: "model_unavailable", pause: "model_unavailable" };
    }
    throw error;
  }
  return null;
}

async function executeRun(run: ClaimedRun, dispatch: () => Promise<ChatDispatch>): Promise<string> {
  const task = await prisma.scheduledTask.findUnique({
    where: { id: run.taskId },
    select: {
      id: true, userId: true, title: true, prompt: true, modelId: true, webSearch: true, creditsPerRun: true, conversationId: true,
      user: { select: { id: true, name: true, email: true, image: true, accountStatus: true, accountDeletionRequestedAt: true,
        settings: { select: { language: true } } } },
    },
  });
  // Deleted while queued: the cascade took the run row too.
  if (!task || task.userId !== run.userId) return "task_deleted";

  const refusal = await eligibility(task, task.user);
  if (refusal) {
    await finalizeRun(run, refusal);
    return refusal.outcome;
  }
  const prepared = await prepareConversation(run, task);
  if (prepared.kind === "skip") {
    await finalizeRun(run, prepared.classification);
    return prepared.classification.outcome;
  }

  const session: Session = {
    user: { id: task.user.id, name: task.user.name, email: task.user.email, image: task.user.image },
    expires: new Date(Date.now() + SCHEDULED_TASK_LIMITS.runLeaseMs).toISOString(),
  };
  const origin = getPublicAppOrigin(new Request("http://localhost/"));
  const request = new Request(new URL("/api/chat", origin), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "accept-language": task.user.settings?.language ?? "en",
    },
    body: JSON.stringify({
      messages: [{ id: prepared.questionRequestId, role: "user", content: task.prompt }],
      modelId: task.modelId,
      conversationId: prepared.conversationId,
      assistantMessageId: run.assistantMessageId,
      sourceUserMessageId: prepared.userMessageId,
      webSearchMode: task.webSearch ? "always" : "off",
    }),
  });

  const post = await dispatch();
  const refusalClassification = await runAsScheduledTask(
    { runId: run.id, userId: run.userId, session, request, creditCeiling: task.creditsPerRun },
    async (): Promise<RunClassification | null> => {
      const response = await post(request);
      if (!response.ok) return classifyChatRefusal(response.status, await readRefusalCode(response));
      if (response.headers.get("x-chat-response-mode") === "image-turn") {
        await response.body?.cancel().catch(() => undefined);
        return { status: "failed", outcome: "image_turn_unsupported", pause: null };
      }
      await drain(response, DISPATCH_TIMEOUT_MS);
      return null;
    }
  );

  const closed = await prisma.scheduledTaskRun.findUnique({
    where: { id: run.id },
    select: { chatReservationId: true },
  });
  if (refusalClassification) {
    await finalizeRun(run, refusalClassification, {
      chargedCredits: await chargedCreditsOf(closed?.chatReservationId ?? null),
      conversationId: prepared.conversationId,
    });
    return refusalClassification.outcome;
  }
  const attempt = await prisma.chatResponseAttempt.findFirst({
    where: { assistantMessageId: run.assistantMessageId, userId: run.userId },
    select: { status: true, failureCode: true, leaseExpiresAt: true },
  });
  const classification = classifyAttempt(attempt, new Date());
  // Still owned and alive: reconciliation settles it once the lease decides.
  if (!classification) return "pending_reconciliation";
  await finalizeRun(run, classification, {
    chargedCredits: await chargedCreditsOf(closed?.chatReservationId ?? null),
    conversationId: prepared.conversationId,
  });
  return classification.outcome;
}

/* ----------------------------------------------------------------- tick -- */

export async function runScheduledTasksTick(input: {
  dispatch: () => Promise<ChatDispatch>;
  enabled?: () => Promise<boolean>;
  now?: () => Date;
}): Promise<ScheduledTaskTickResult> {
  const result: ScheduledTaskTickResult = {
    enabled: false, reconciled: 0, claimed: 0, skippedLate: 0, deferred: 0, executed: {},
  };
  if (!(await (input.enabled ?? isScheduledTasksEnabled)())) return result;
  result.enabled = true;
  const now = input.now?.() ?? new Date();
  result.reconciled = await reconcileExpiredScheduledRuns(now);

  const due = await prisma.scheduledTask.findMany({
    where: { status: "active", nextRunAt: { lte: now } },
    orderBy: { nextRunAt: "asc" },
    take: SCHEDULED_TASK_LIMITS.claimBatch,
    select: { id: true },
  });
  const claimed: ClaimedRun[] = [];
  for (const { id } of due) {
    const outcome = await claimTask(id, now);
    if (outcome.kind === "claimed") claimed.push(outcome.run);
    else if (outcome.kind === "late") result.skippedLate += 1;
    else if (outcome.kind === "deferred") result.deferred += 1;
  }
  result.claimed = claimed.length;

  let next = 0;
  const worker = async () => {
    while (next < claimed.length) {
      const run = claimed[next++]!;
      let outcome: string;
      try {
        outcome = await executeRun(run, input.dispatch);
      } catch (error) {
        // An exception is not an answer: the run stays `running` and its lease
        // decides, from the attempt row, what really happened.
        console.warn(JSON.stringify({
          event: "scheduled_task_run_error",
          runId: run.id,
          error: error instanceof Error ? error.name : "unknown",
          timestamp: new Date().toISOString(),
        }));
        outcome = "error";
      }
      result.executed[outcome] = (result.executed[outcome] ?? 0) + 1;
    }
  };
  await Promise.all(Array.from({ length: Math.min(SCHEDULED_TASK_LIMITS.executionConcurrency, claimed.length) }, worker));
  return result;
}

/** For the maintenance route: never throws, logs one line. */
export async function runScheduledTasksQuietly() {
  try {
    const result = await runScheduledTasksTick({
      dispatch: async () => (await import("@/app/api/chat/route")).POST,
    });
    if (result.enabled) {
      console.info(JSON.stringify({ event: "scheduled_tasks_tick", ...result, timestamp: new Date().toISOString() }));
    }
    return result;
  } catch (error) {
    console.warn(JSON.stringify({
      event: "scheduled_tasks_tick_failed",
      error: error instanceof Error ? error.name : "unknown",
      timestamp: new Date().toISOString(),
    }));
    return null;
  }
}
