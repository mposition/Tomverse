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
  onceTaskRetryAt,
  planRunsScheduledTasks,
  SCHEDULED_TASK_LIMITS,
  scheduledTasksHostProblem,
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
  resumed: number;
  claimed: number;
  skippedLate: number;
  skippedTooSoon: number;
  deferred: number;
  /** Due tasks this tick looked at: claimed, skipped, deferred or taken by another tick. */
  examined: number;
  /** Work was left for the next tick because the deadline was too close. */
  stoppedForTime: boolean;
  /**
   * The tick stopped at one of its bounds with due tasks possibly left for the
   * next tick: `claims` (the most runs one tick claims) or `scan` (the most
   * due tasks one tick looks at).
   */
  stoppedAtLimit: "claims" | "scan" | null;
  /** The feature switch or the kill switch went off while the tick ran: nothing further was started. */
  stoppedBySwitch: boolean;
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

export type RunRef = { id: string; taskId: string; userId: string; taskRevision: number };

/**
 * Closes a run and applies its consequence to the task, in one transaction.
 * Conditional on the run still being `running`, so a reconciliation and a
 * finishing worker cannot both apply a result.
 *
 * The consequence (failure streak, a pause, a one-off completing) applies only
 * to the task version the run was claimed for. A person who paused, resumed or
 * edited the task meanwhile has already decided its state; an old run's verdict
 * must not clear the schedule they just saved.
 */
async function finalizeRun(
  run: RunRef,
  classification: RunClassification,
  extra: {
    chargedCredits?: number | null;
    conversationId?: string | null;
    /**
     * Set by reconciliation, which acts on a run nobody owns: the close only
     * happens while the lease is still lapsed at that instant, so a run
     * another tick has just taken (and may be dispatching) is never closed
     * under it.
     */
    onlyIfLapsedAt?: Date;
  } = {}
) {
  return prisma.$transaction(async (tx) => {
    const closed = await tx.scheduledTaskRun.updateMany({
      where: {
        id: run.id,
        status: "running",
        ...(extra.onlyIfLapsedAt ? { leaseExpiresAt: { lt: extra.onlyIfLapsedAt } } : {}),
      },
      data: {
        status: classification.status,
        outcome: classification.outcome,
        runningUserId: null,
        finishedAt: new Date(),
        ...(extra.chargedCredits !== undefined ? { chargedCredits: extra.chargedCredits } : {}),
      },
    });
    if (!closed.count) return false;
    // Locked, so an edit cannot commit between this read and the write below.
    const rows = await tx.$queryRaw<Array<{ status: string; frequency: string; consecutiveFailures: number; revision: number }>>`
      SELECT "status", "frequency", "consecutiveFailures", "revision" FROM "ScheduledTask"
      WHERE "id" = ${run.taskId} FOR UPDATE`;
    const task = rows[0];
    if (task && task.status === "active" && task.revision === run.taskRevision) {
      const streak = failureStreakAfter(task.consecutiveFailures, classification);
      // A one-time task whose run was refused by the platform or stopped by
      // the operator is not finished: it is due again (onceTaskRetryAt).
      let retryAt: Date | null = null;
      if (!streak.pause && task.frequency === "once") {
        // The first occurrence of this schedule: runs of the revision this run
        // was claimed for. An edit starts a new revision, so a task that was
        // rescheduled, or was recurring before it became one-time, is not
        // measured from runs of a schedule it no longer has.
        const first = await tx.scheduledTaskRun.aggregate({
          where: { taskId: run.taskId, taskRevision: run.taskRevision },
          _min: { scheduledFor: true },
        });
        retryAt = first._min.scheduledFor
          ? onceTaskRetryAt({ classification, now: new Date(), firstScheduledFor: first._min.scheduledFor })
          : null;
      }
      await tx.scheduledTask.update({
        where: { id: run.taskId },
        data: {
          consecutiveFailures: streak.consecutiveFailures,
          ...(streak.pause
            ? { status: "paused", pauseReason: streak.pause, nextRunAt: null }
            : task.frequency === "once"
              ? retryAt
                ? { nextRunAt: retryAt }
                : { status: "completed", nextRunAt: null }
              : {}),
        },
      });
    }
    // The sidebar is ordered by updatedAt: a fresh answer moves its
    // conversation to the top, which is the whole of the notification.
    if (classification.status === "succeeded" && extra.conversationId) {
      await tx.conversation.updateMany({
        where: { id: extra.conversationId, userId: run.userId },
        data: { updatedAt: new Date() },
      });
    }
    return true;
  });
}

/**
 * What the run was charged, when that is knowable from its one reservation.
 * The Chat route reserves once per request; if the run's own total says more
 * than that reservation held, the figure is left unknown rather than reported
 * low.
 */
const chargedCreditsOf = async (run: { chatReservationId: string | null; reservedCredits: number }) => {
  if (!run.chatReservationId) return null;
  const reservation = await prisma.chatCreditReservation.findUnique({
    where: { id: run.chatReservationId },
    select: { settledAt: true, settledCredits: true, reservedCredits: true },
  });
  if (!reservation?.settledAt || reservation.reservedCredits !== run.reservedCredits) return null;
  return reservation.settledCredits;
};

/* -------------------------------------------------------- reconciliation -- */

export type ClaimedRun = RunRef & { assistantMessageId: string };

export type ResumableRun = ClaimedRun & { scheduledFor: Date };

/**
 * Runs whose lease lapsed, settled from the durable Chat attempt.
 *
 * One case is resumed rather than closed: no attempt and no reservation means
 * the run stopped before the Chat route claimed anything, so nothing was sent
 * and nothing was charged -- verified, not assumed. If its task is unchanged
 * and its occurrence still inside the grace window it is returned as a
 * candidate; a worker takes its lease only when it is about to run it
 * (`acquireResumable`), with the same run id, so the same question and answer
 * identities: a second worker that does reach Chat can only reattach. A
 * candidate whose task was paused or edited is closed now, so it does not hold
 * the account's one slot. Every other lapsed run is closed from its attempt and
 * never sent again.
 */
export async function reconcileExpiredScheduledRuns(now = new Date()) {
  const stale = await prisma.scheduledTaskRun.findMany({
    where: { status: "running", leaseExpiresAt: { lt: now } },
    orderBy: { leaseExpiresAt: "asc" },
    take: 100,
    select: {
      id: true, taskId: true, userId: true, taskRevision: true, assistantMessageId: true, conversationId: true,
      chatReservationId: true, reservedCredits: true, scheduledFor: true,
      task: { select: { status: true, revision: true } },
    },
  });
  let reconciled = 0;
  const resumable: ResumableRun[] = [];
  for (const { task, ...run } of stale) {
    const attempt = await prisma.chatResponseAttempt.findFirst({
      where: { assistantMessageId: run.assistantMessageId, userId: run.userId },
      select: { status: true, failureCode: true, leaseExpiresAt: true },
    });
    // Every close here is conditional on the lease still being lapsed: another
    // tick may have taken this run since it was read.
    const lapsed = { onlyIfLapsedAt: now };
    let closed = false;
    if (!attempt && !run.chatReservationId) {
      if (task.status !== "active" || task.revision !== run.taskRevision) {
        closed = await finalizeRun(run, { status: "skipped", outcome: "task_changed", pause: null }, lapsed);
      } else if (now.getTime() - run.scheduledFor.getTime() <= SCHEDULED_TASK_LIMITS.lateGraceMs) {
        resumable.push(run);
        continue;
      } else {
        closed = await finalizeRun(run, { status: "failed", outcome: "interrupted", pause: null }, lapsed);
      }
    } else {
      const classification = classifyAttempt(attempt, now);
      if (!classification) continue;
      closed = await finalizeRun(run, classification, {
        chargedCredits: await chargedCreditsOf(run),
        conversationId: run.conversationId,
        ...lapsed,
      });
    }
    if (closed) reconciled += 1;
  }
  return { reconciled, resumable };
}

/**
 * Takes a resumable run's lease at the moment a worker is about to run it.
 * Conditional on the lease still being lapsed, so two ticks cannot both take
 * it; and the grace window is judged again at this instant, not at the start
 * of the tick.
 *
 * `startedAt` moves to this instant in the same write. A resumable run never
 * reached Chat, so this is when it really starts, and the minimum interval
 * between paid runs (`decideDueOccurrence`'s `previousStartedAt`) is measured
 * from here: a run resumed two hours after its claim keeps the task's next run
 * a full interval after the resume, not after the claim.
 */
export async function acquireResumable(
  run: ResumableRun,
  now: Date
): Promise<{ run: ClaimedRun | null; closed: boolean }> {
  if (now.getTime() - run.scheduledFor.getTime() > SCHEDULED_TASK_LIMITS.lateGraceMs) {
    // Too late to start -- and only if nobody took it meanwhile.
    const closed = await finalizeRun(run, { status: "failed", outcome: "interrupted", pause: null }, { onlyIfLapsedAt: now });
    return { run: null, closed };
  }
  const taken = await prisma.scheduledTaskRun.updateMany({
    where: { id: run.id, status: "running", leaseExpiresAt: { lt: now } },
    data: { leaseExpiresAt: new Date(now.getTime() + SCHEDULED_TASK_LIMITS.runLeaseMs), startedAt: now },
  });
  return { run: taken.count ? run : null, closed: false };
}

/* ---------------------------------------------------------------- claim -- */

/** The account's own Chat in flight leaves at least one slot free for it. */
const accountChatBusy = async (tx: Prisma.TransactionClient, userId: string) => {
  // The same subject key and limit the Chat route computes for this account.
  const access = identifyChatCaller(new Request("https://scheduled-task.invalid/"), userId);
  const limit = resolveChatConcurrencyPlan({ kind: "user", subjectKey: access.subjectKey, ipKey: access.ipKey }).subject.limit;
  const rows = await tx.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(*)::bigint AS "count" FROM "ChatRequestLease"
    WHERE "subjectKey" = ${access.subjectKey} AND "expiresAt" > NOW()`;
  return Number(rows[0]?.count ?? 0) >= Math.max(1, limit - 1);
};

type ClaimOutcome =
  | { kind: "claimed"; run: ClaimedRun }
  | { kind: "late" }
  | { kind: "too_soon" }
  | { kind: "deferred" }
  | { kind: "none" };

async function claimTask(taskId: string, now: Date): Promise<ClaimOutcome> {
  try {
    return await prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{
        id: string; userId: string; revision: number; nextRunAt: Date; frequency: string; timeOfDay: string;
        dayOfWeek: number | null; dayOfMonth: number | null; runOnDate: string | null; timeZone: string;
      }>>`
        SELECT "id", "userId", "revision", "nextRunAt", "frequency", "timeOfDay", "dayOfWeek", "dayOfMonth", "runOnDate", "timeZone"
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
      // The latest run by when it really started, whatever occurrence it was
      // (a resumed run's start is its resume: acquireResumable moves it).
      const lastStarted = await tx.scheduledTaskRun.findFirst({
        where: { taskId },
        orderBy: { startedAt: "desc" },
        select: { startedAt: true },
      });
      const decision = decideDueOccurrence({
        schedule,
        dueAt: task.nextRunAt,
        now,
        previousScheduledFor: previous?.scheduledFor ?? null,
        previousStartedAt: lastStarted?.startedAt ?? null,
      });
      if (decision.kind !== "run") {
        await tx.scheduledTask.update({
          where: { id: taskId },
          data: decision.next ? { nextRunAt: decision.next } : { nextRunAt: null, status: "completed" },
        });
        return { kind: decision.kind === "skip_late" ? "late" : "too_soon" } as const;
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
          taskRevision: task.revision,
          scheduledFor: decision.scheduledFor,
          assistantMessageId: scheduledRunAssistantMessageId(runId),
          // Claimed by the worker that is about to execute it, so the lease
          // covers the run itself and not a wait behind other runs.
          leaseExpiresAt: new Date(now.getTime() + SCHEDULED_TASK_LIMITS.runLeaseMs),
        },
        select: { id: true, taskId: true, userId: true, taskRevision: true, assistantMessageId: true },
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
      // Run row, then task row -- the order the reservation guard and
      // finalizeRun take them in. Serialised with a pause or an edit: one that
      // committed first wins and nothing is written to Chat for this run.
      const owned = await tx.$queryRaw<Array<{ status: string }>>`
        SELECT "status" FROM "ScheduledTaskRun" WHERE "id" = ${run.id} FOR UPDATE`;
      if (owned[0]?.status !== "running") {
        return { kind: "skip", classification: { status: "skipped", outcome: "task_changed", pause: null } } as const;
      }
      const current = await tx.$queryRaw<Array<{ status: string; revision: number }>>`
        SELECT "status", "revision" FROM "ScheduledTask" WHERE "id" = ${task.id} FOR UPDATE`;
      if (current[0]?.status !== "active" || current[0].revision !== run.taskRevision) {
        return { kind: "skip", classification: { status: "skipped", outcome: "task_changed", pause: null } } as const;
      }
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
        // The lease restarts as the dispatch begins, so it covers the dispatch.
        data: { conversationId, userMessageId, leaseExpiresAt: new Date(Date.now() + SCHEDULED_TASK_LIMITS.runLeaseMs) },
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

async function executeRun(run: ClaimedRun, dispatch: () => Promise<ChatDispatch>, deadline: number): Promise<string> {
  const task = await prisma.scheduledTask.findUnique({
    where: { id: run.taskId },
    select: {
      id: true, userId: true, title: true, prompt: true, modelId: true, webSearch: true, creditsPerRun: true, conversationId: true,
      status: true, revision: true,
      user: { select: { id: true, name: true, email: true, image: true, accountStatus: true, accountDeletionRequestedAt: true,
        settings: { select: { language: true } } } },
    },
  });
  // Deleted while queued: the cascade took the run row too.
  if (!task || task.userId !== run.userId) return "task_deleted";
  // Paused or edited since the claim: this version of the task is not run.
  if (task.status !== "active" || task.revision !== run.taskRevision) {
    const changed: RunClassification = { status: "skipped", outcome: "task_changed", pause: null };
    await finalizeRun(run, changed);
    return changed.outcome;
  }

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
  // The whole turn -- dispatch, reading the answer to its end, settling the
  // run -- is one promise. The tick waits for it only until its deadline; past
  // that it keeps running here (the Chat stream is pulled by this reader, so
  // it must keep reading) and settles the run itself. If the process dies
  // first, the run's lease lapses and the next tick settles it from the Chat
  // attempt row: the same assistant id, so nothing is sent or charged twice.
  const finishing = runAsScheduledTask(
    { runId: run.id, userId: run.userId, session, request, creditCeiling: task.creditsPerRun },
    () => dispatchAndSettle(run, post, request, prepared.conversationId)
  ).catch((error: unknown) => {
    console.warn(JSON.stringify({
      event: "scheduled_task_run_error",
      runId: run.id,
      error: error instanceof Error ? error.name : "unknown",
      timestamp: new Date().toISOString(),
    }));
    return "error";
  });
  const waited = await untilDeadline(finishing, deadline);
  return waited === TIMED_OUT ? "continues_after_tick" : waited;
}

async function dispatchAndSettle(run: ClaimedRun, post: ChatDispatch, request: Request, conversationId: string) {
  let refusalClassification: RunClassification | null = null;
  const response = await post(request);
  if (!response.ok) {
    refusalClassification = classifyChatRefusal(response.status, await readRefusalCode(response));
  } else if (response.headers.get("x-chat-response-mode") === "image-turn") {
    await response.body?.cancel().catch(() => undefined);
    refusalClassification = { status: "failed", outcome: "image_turn_unsupported", pause: null };
  } else {
    await drain(response, DISPATCH_TIMEOUT_MS);
  }

  const closed = await prisma.scheduledTaskRun.findUnique({
    where: { id: run.id },
    select: { chatReservationId: true, reservedCredits: true },
  });
  const charged = closed ? await chargedCreditsOf(closed) : null;
  if (refusalClassification) {
    await finalizeRun(run, refusalClassification, { chargedCredits: charged, conversationId });
    return refusalClassification.outcome;
  }
  const attempt = await prisma.chatResponseAttempt.findFirst({
    where: { assistantMessageId: run.assistantMessageId, userId: run.userId },
    select: { status: true, failureCode: true, leaseExpiresAt: true },
  });
  const classification = classifyAttempt(attempt, new Date());
  // Still owned and alive: reconciliation settles it once the lease decides.
  if (!classification) return "pending_reconciliation";
  await finalizeRun(run, classification, { chargedCredits: charged, conversationId });
  return classification.outcome;
}

const TIMED_OUT = Symbol("timed_out");

/** The work's result, or TIMED_OUT at the deadline -- the work itself is not stopped. */
const untilDeadline = async <T>(work: Promise<T>, deadline: number): Promise<T | typeof TIMED_OUT> => {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return TIMED_OUT;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), remaining);
    })]);
  } finally {
    clearTimeout(timer);
  }
};

/* ----------------------------------------------------------------- tick -- */

export async function runScheduledTasksTick(input: {
  dispatch: () => Promise<ChatDispatch>;
  enabled?: () => Promise<boolean>;
  now?: () => Date;
  /**
   * When this tick must have returned, in epoch ms -- the calling request's
   * own time limit. Defaults to SCHEDULED_TASK_LIMITS.tickBudgetMs from now.
   */
  deadline?: number;
  /** Time a new run needs left before the deadline to be started at all. */
  startReserveMs?: number;
  /** The per-tick bounds; SCHEDULED_TASK_LIMITS.claimBatch and dueScanLimit unless a test names smaller ones. */
  claimLimit?: number;
  scanLimit?: number;
}): Promise<ScheduledTaskTickResult> {
  const result: ScheduledTaskTickResult = {
    enabled: false, reconciled: 0, resumed: 0, claimed: 0, skippedLate: 0, skippedTooSoon: 0, deferred: 0,
    examined: 0, stoppedForTime: false, stoppedAtLimit: null, stoppedBySwitch: false, executed: {},
  };
  const enabled = input.enabled ?? isScheduledTasksEnabled;
  if (!(await enabled())) return result;
  result.enabled = true;
  const deadline = input.deadline ?? Date.now() + SCHEDULED_TASK_LIMITS.tickBudgetMs;
  const startReserveMs = input.startReserveMs ?? SCHEDULED_TASK_LIMITS.runStartReserveMs;
  const claimLimit = input.claimLimit ?? SCHEDULED_TASK_LIMITS.claimBatch;
  const scanLimit = input.scanLimit ?? SCHEDULED_TASK_LIMITS.dueScanLimit;
  // Read at every decision, not once per tick: a tick can spend many minutes
  // on earlier runs, and lateness is judged when a run is about to start.
  const clock = input.now ?? (() => new Date());
  const reconciliation = await reconcileExpiredScheduledRuns(clock());
  result.reconciled = reconciliation.reconciled;

  // Due tasks are read oldest first, a page at a time, behind a cursor on
  // (nextRunAt, id) as read. A claimed, late or too-soon task leaves the due
  // set (its nextRunAt moves on); a deferred one keeps its time and the cursor
  // passes it, so tasks that cannot start now never hold the window shut for
  // the tasks behind them. An account with a scheduled run in flight is not
  // read at all: its tasks could only be deferred.
  //
  // What the bounds guarantee. Reading stops at claimLimit claims, at
  // scanLimit tasks looked at, or when time runs short, and everything not
  // reached stays due, untouched, for the next tick (every 15 minutes). So a
  // due task is looked at in every tick unless that tick first claimed
  // claimLimit runs, ran short of time, or looked at scanLimit older due tasks
  // -- which, once claimed, late and too-soon ones have left, were all
  // deferred in that same tick. Passing a task over for its whole grace window
  // (twelve ticks) by the scan bound alone therefore takes more than scanLimit
  // tasks deferred in every one of those ticks: at most maxActiveTasks per
  // account, so at the defaults 40 accounts with their own Chat busy for three
  // hours. Such a task is then skipped late like any missed occurrence; it is
  // never fired as a backlog and never charged.
  const dueAsOf = clock();
  let page: Array<{ id: string; nextRunAt: Date | null }> = [];
  let inPage = 0;
  let cursor: { nextRunAt: Date; id: string } | null = null;
  let moreDue = true;
  const readDuePage = async () => {
    const take = Math.min(SCHEDULED_TASK_LIMITS.claimBatch, scanLimit - result.examined);
    page = await prisma.scheduledTask.findMany({
      where: {
        status: "active",
        nextRunAt: { lte: dueAsOf },
        ...(cursor ? { OR: [{ nextRunAt: { gt: cursor.nextRunAt } }, { nextRunAt: cursor.nextRunAt, id: { gt: cursor.id } }] } : {}),
        user: { scheduledTaskRuns: { none: { status: "running" } } },
      },
      orderBy: [{ nextRunAt: "asc" }, { id: "asc" }],
      take,
      select: { id: true, nextRunAt: true },
    });
    inPage = 0;
    moreDue = page.length === take;
    const last = page.at(-1);
    if (last?.nextRunAt) cursor = { nextRunAt: last.nextRunAt, id: last.id };
  };
  await readDuePage();

  // Work is claimed (or a resumable run's lease taken) by the worker that is
  // about to run it, never in advance: a lease spent waiting behind other runs
  // would lapse before its run began.
  const resumable = [...reconciliation.resumable];
  const takeWork = async (): Promise<ClaimedRun | null> => {
    // Nothing new starts without the time to finish inside this request; what
    // is left stays due (or resumable) for the next tick.
    if (Date.now() + startReserveMs > deadline) {
      result.stoppedForTime = resumable.length > 0 || inPage < page.length || moreDue;
      return null;
    }
    // The emergency stop, read again before every start: a tick runs for
    // minutes, and an operator who turns scheduled tasks off must not see it
    // start another paid turn. What is left stays due or resumable. (The
    // reservation guard checks once more where credits are held.)
    if (result.stoppedBySwitch || !(await enabled())) {
      result.stoppedBySwitch = true;
      return null;
    }
    for (let candidate = resumable.shift(); candidate; candidate = resumable.shift()) {
      const taken = await acquireResumable(candidate, clock());
      if (taken.closed) result.reconciled += 1;
      if (taken.run) {
        result.resumed += 1;
        return taken.run;
      }
    }
    while (inPage < page.length || moreDue) {
      if (result.claimed >= claimLimit) {
        result.stoppedAtLimit = "claims";
        return null;
      }
      if (inPage === page.length) {
        if (result.examined >= scanLimit) {
          result.stoppedAtLimit = "scan";
          return null;
        }
        await readDuePage();
        continue;
      }
      result.examined += 1;
      const outcome = await claimTask(page[inPage++]!.id, clock());
      if (outcome.kind === "claimed") {
        result.claimed += 1;
        return outcome.run;
      }
      if (outcome.kind === "late") result.skippedLate += 1;
      else if (outcome.kind === "too_soon") result.skippedTooSoon += 1;
      else if (outcome.kind === "deferred") result.deferred += 1;
    }
    return null;
  };
  // One worker takes work at a time: the page and its cursor are shared, and a
  // claim is one short transaction. Running the claimed runs is what overlaps.
  let taking: Promise<unknown> = Promise.resolve();
  const takeWorkInTurn = () => {
    const next = taking.then(takeWork);
    taking = next.catch(() => undefined);
    return next;
  };
  const worker = async () => {
    for (let run = await takeWorkInTurn(); run; run = await takeWorkInTurn()) {
      let outcome: string;
      try {
        outcome = await executeRun(run, input.dispatch, deadline);
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
  await Promise.all(Array.from({ length: SCHEDULED_TASK_LIMITS.executionConcurrency }, worker));
  return result;
}

/**
 * For the maintenance route: never throws, logs one line. `deadline` is the
 * route's own time limit (request start + maxDuration, less a margin), so the
 * tick returns inside the request whatever the platform enforces.
 */
export async function runScheduledTasksQuietly(options: { deadline?: number; env?: Record<string, string | undefined> } = {}) {
  // Nothing unattended starts where a started turn could be cut off with the
  // request (see scheduledTasksHostProblem).
  const hostProblem = scheduledTasksHostProblem(options.env ?? process.env);
  if (hostProblem) {
    console.warn(JSON.stringify({ event: "scheduled_tasks_tick_skipped", reason: hostProblem, timestamp: new Date().toISOString() }));
    return null;
  }
  try {
    const result = await runScheduledTasksTick({
      dispatch: async () => (await import("@/app/api/chat/route")).POST,
      deadline: options.deadline,
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
