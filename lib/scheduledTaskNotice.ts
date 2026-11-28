import "server-only";

import { appUrl } from "@/lib/accountEmails";
import { conversationHandoffHref } from "@/lib/continuationRoutes";
import { consentGateVerdict } from "@/lib/emailPreferenceCore";
import {
  SCHEDULED_TASK_PAUSED_TEMPLATE,
  SCHEDULED_TASK_RUN_ANSWERED_TEMPLATE,
  type ScheduledTaskNoticePayload,
} from "@/lib/emailTemplateDefinitions";
import { ensureTemplateVersion } from "@/lib/emailTemplateRegistry";
import { prisma } from "@/lib/prisma";
import { CHAT_WORKSPACE_PATH } from "@/lib/productSurfaceRoutes";
import {
  formatScheduledRunTime,
  recoveredNoticeKind,
  SCHEDULED_TASK_NOTICE_RECOVERY_BATCH,
  SCHEDULED_TASK_NOTICE_RECOVERY_WINDOW_MS,
  scheduledTaskEmailEnabled,
  type ScheduledRunNoticeKind,
} from "@/lib/scheduledTaskCore";
import {
  SCHEDULED_TASK_NOTICE_PURPOSE,
  SCHEDULED_TASK_NOTICE_REFERENCE,
  scheduledTaskNoticeWanted,
} from "@/lib/scheduledTaskNoticeGate";
import { enqueueRefused, enqueueStandardEmail, resolveEmailLanguage } from "@/lib/standardEmailLane";

/**
 * The email that tells an account its scheduled task finished: a run answered,
 * or the runner paused the task (docs/policy/email-notifications.md §3.2, 4a).
 *
 * `ScheduledTaskRun.noticeQueuedAt` is the run's notice, settled: set once,
 * only while NULL, when the notice was queued or decided against. NULL means a
 * notice may still be owed. The run's close sets it at once when none is owed
 * or the email switch is off (lib/scheduledTaskRunner.ts, finalizeRun), so only
 * a run that owed one and has not had it queued stays NULL -- which is what the
 * recovery below looks for.
 *
 * The send boundary, in order:
 *
 *   1. `SCHEDULED_TASK_EMAIL_ENABLED` must be exactly "true" (default off).
 *      Off, nothing is read and nothing is written here.
 *   2. Once per run: the marker is claimed only while NULL, in the same
 *      transaction that writes the outbox rows. A retried, reconciled or
 *      doubled finish finds it set and queues nothing.
 *   3. Inside that transaction, the task's own "email me when it finishes"
 *      switch, with the task row locked (lib/scheduledTaskNoticeGate.ts).
 *   4. Inside it too, the account's `scheduled_tasks` email purpose
 *      (/settings/notifications), through `consentGateVerdict`.
 *
 * A refusal at 3 or 4 is a decision and keeps the claim: the run is settled,
 * and switching the email back on later does not send it. Only an error rolls
 * the claim back, leaving the run to the recovery.
 *
 * Both 3 and 4 are asked again by the standard lane immediately before it
 * sends, so a switch turned off -- or a task deleted -- after the message was
 * queued still stops it.
 *
 * Only the standard lane sends (its provider, domains, idempotency key and
 * retries). This module never calls a provider, so there is no send outcome
 * here to be unsure about; the lane never re-sends a message whose provider
 * outcome it cannot confirm.
 */

export type ScheduledRunNoticeOutcome =
  | "queued"
  | "switch_off"
  | "not_found"
  | "already_settled"
  | "task_off"
  | "no_address"
  | "preference_off"
  | "refused";

export async function queueScheduledRunNotice(input: {
  runId: string;
  kind: ScheduledRunNoticeKind;
  env?: Record<string, string | undefined>;
  now?: Date;
}): Promise<ScheduledRunNoticeOutcome> {
  if (!scheduledTaskEmailEnabled(input.env ?? process.env)) return "switch_off";

  // What the message says. Whether it may be queued at all is decided below,
  // inside the transaction that queues it.
  const run = await prisma.scheduledTaskRun.findUnique({
    where: { id: input.runId },
    select: {
      userId: true,
      startedAt: true,
      conversationId: true,
      noticeQueuedAt: true,
      task: { select: { title: true, timeZone: true, conversationId: true } },
      user: { select: { email: true, settings: { select: { language: true } } } },
    },
  });
  if (!run) return "not_found";
  if (run.noticeQueuedAt) return "already_settled";
  const emailAddress = run.user.email;

  const language = resolveEmailLanguage(run.user.settings?.language);
  const templateKey = input.kind === "answered" ? SCHEDULED_TASK_RUN_ANSWERED_TEMPLATE : SCHEDULED_TASK_PAUSED_TEMPLATE;
  // Registered before the transaction, so the enqueue inside it only reads.
  if (emailAddress) await ensureTemplateVersion({ templateKey, language });

  const base = appUrl().replace(/\/+$/, "");
  const conversationId = run.conversationId ?? run.task.conversationId;
  const tasksUrl = `${base}/settings/scheduled-tasks`;
  const payload: ScheduledTaskNoticePayload = {
    taskTitle: run.task.title,
    runAt: formatScheduledRunTime(run.startedAt, run.task.timeZone, language),
    actionUrl:
      input.kind === "answered" && conversationId
        ? `${base}${conversationHandoffHref("chat", conversationId, CHAT_WORKSPACE_PATH)}`
        : tasksUrl,
    settingsUrl: `${base}/settings/notifications`,
  };

  return prisma.$transaction(async (tx): Promise<ScheduledRunNoticeOutcome> => {
    const claimed = await tx.scheduledTaskRun.updateMany({
      where: { id: input.runId, noticeQueuedAt: null },
      data: { noticeQueuedAt: input.now ?? new Date() },
    });
    if (!claimed.count) return "already_settled";
    // The task's own switch, read with the task row locked: a settings save
    // committed before this is seen, and one that comes after waits for the
    // notice to be queued -- and is then checked again at send.
    if ((await scheduledTaskNoticeWanted(input.runId, { tx, lock: true })) !== "wanted") return "task_off";
    if (!emailAddress) return "no_address";
    // The account's purpose, read inside the same transaction. The drain
    // decides it again at send time with the same verdict.
    const preference = await tx.emailPreference.findUnique({
      where: { userId_purpose: { userId: run.userId, purpose: SCHEDULED_TASK_NOTICE_PURPOSE } },
      select: { enabled: true, confirmedAt: true },
    });
    const consent = consentGateVerdict({
      classification: "service",
      purpose: SCHEDULED_TASK_NOTICE_PURPOSE,
      hasAccount: true,
      storedEnabled: preference?.enabled ?? null,
      storedConfirmedAt: preference?.confirmedAt ?? null,
    });
    if (!consent.allowed) return "preference_off";
    const queued = await enqueueStandardEmail({
      tx,
      templateKey,
      emailAddress,
      userId: run.userId,
      language,
      payload,
      referenceType: SCHEDULED_TASK_NOTICE_REFERENCE,
      referenceId: input.runId,
    });
    return enqueueRefused(queued) ? "refused" : "queued";
  });
}

/**
 * The runner's call: never throws. A notice that could not be queued is a
 * missing email, not a reason to leave a finished run open -- and the run's
 * marker stays NULL, so the recovery below queues it on a later tick.
 */
export async function queueScheduledRunNoticeQuietly(input: { runId: string; kind: ScheduledRunNoticeKind; now?: Date }) {
  try {
    return await queueScheduledRunNotice(input);
  } catch (error) {
    console.error("Failed to queue a scheduled task notice:", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return "failed" as const;
  }
}

export type ScheduledRunNoticeRecovery = { examined: number; queued: number; settled: number; failed: number };

/**
 * Queues the notices that were owed and never settled: the process died between
 * a run's close and its enqueue, or the enqueue failed. Run by every scheduled
 * task tick, after the lease reconciliation.
 *
 * Bounded three ways: only while the email switch is on (off, nothing is read);
 * only runs that finished within SCHEDULED_TASK_NOTICE_RECOVERY_WINDOW_MS; at
 * most SCHEDULED_TASK_NOTICE_RECOVERY_BATCH per tick, oldest first. Each run
 * goes through `queueScheduledRunNotice` -- the same claim, the same locked
 * switch and the same purpose verdict -- so a run being queued by its own close
 * at this moment is queued once. A run that turns out to have owed nothing (a
 * row from before the marker was written at close) is settled without mail.
 */
export async function reconcileScheduledRunNotices(input: {
  env?: Record<string, string | undefined>;
  limit?: number;
  /** The one instant this pass settles and queues at; the tick passes its own clock. */
  now?: Date;
} = {}): Promise<ScheduledRunNoticeRecovery> {
  const recovery: ScheduledRunNoticeRecovery = { examined: 0, queued: 0, settled: 0, failed: 0 };
  const now = input.now ?? new Date();
  const env = input.env ?? process.env;
  if (!scheduledTaskEmailEnabled(env)) return recovery;
  const limit = input.limit ?? SCHEDULED_TASK_NOTICE_RECOVERY_BATCH;
  const windowSeconds = Math.floor(SCHEDULED_TASK_NOTICE_RECOVERY_WINDOW_MS / 1000);
  const rows = await prisma.$queryRaw<
    Array<{
      id: string;
      status: string;
      taskRevision: number;
      taskStatus: string;
      revision: number;
      pauseReason: string | null;
      isLatestRun: boolean;
    }>
  >`
    SELECT r."id", r."status", r."taskRevision",
           t."status" AS "taskStatus", t."revision", t."pauseReason",
           NOT EXISTS (
             SELECT 1 FROM "ScheduledTaskRun" later
             WHERE later."taskId" = r."taskId" AND later."scheduledFor" > r."scheduledFor"
           ) AS "isLatestRun"
    FROM "ScheduledTaskRun" r
    JOIN "ScheduledTask" t ON t."id" = r."taskId"
    WHERE r."noticeQueuedAt" IS NULL
      AND r."status" <> 'running'
      AND r."finishedAt" >= NOW() - (${windowSeconds}::int * INTERVAL '1 second')
    ORDER BY r."finishedAt" ASC
    LIMIT ${limit}
  `;
  for (const row of rows) {
    recovery.examined += 1;
    const kind = recoveredNoticeKind({
      runStatus: row.status,
      runRevision: row.taskRevision,
      taskStatus: row.taskStatus,
      taskRevision: row.revision,
      pauseReason: row.pauseReason,
      isLatestRun: row.isLatestRun,
    });
    if (!kind) {
      await prisma.scheduledTaskRun.updateMany({
        where: { id: row.id, noticeQueuedAt: null },
        data: { noticeQueuedAt: now },
      });
      recovery.settled += 1;
      continue;
    }
    // One failing row must not stop the rest; it stays NULL for the next tick.
    const outcome = await queueScheduledRunNoticeQuietly({ runId: row.id, kind, now });
    if (outcome === "queued") recovery.queued += 1;
    else if (outcome === "failed") recovery.failed += 1;
    else recovery.settled += 1;
  }
  return recovery;
}

/** The tick's call: never throws, for the reason the runner's call does not. */
export async function reconcileScheduledRunNoticesQuietly(now?: Date): Promise<ScheduledRunNoticeRecovery> {
  try {
    return await reconcileScheduledRunNotices({ now });
  } catch (error) {
    console.error("Failed to recover scheduled task notices:", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return { examined: 0, queued: 0, settled: 0, failed: 1 };
  }
}
