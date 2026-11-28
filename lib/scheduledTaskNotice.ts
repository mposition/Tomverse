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
  scheduledTaskEmailEnabled,
  type ScheduledRunNoticeKind,
} from "@/lib/scheduledTaskCore";
import { enqueueRefused, enqueueStandardEmail, resolveEmailLanguage } from "@/lib/standardEmailLane";

/**
 * The email that tells an account its scheduled task finished: a run answered,
 * or the runner paused the task (docs/policy/email-notifications.md §3.2, 4a).
 *
 * The send boundary, in order -- each refusal queues nothing:
 *
 *   1. `SCHEDULED_TASK_EMAIL_ENABLED` must be exactly "true" (default off).
 *      Off, nothing is read and nothing is written.
 *   2. The task's own "email me when it finishes" switch.
 *   3. The account's `scheduled_tasks` email purpose (/settings/notifications),
 *      through the same `consentGateVerdict` the drain applies again at send.
 *   4. Once per run: `ScheduledTaskRun.noticeQueuedAt` is claimed only while
 *      NULL, in the same transaction that writes the outbox rows. A retried,
 *      reconciled or doubled finish finds it set and queues nothing; a failed
 *      enqueue rolls the claim back with it.
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
  | "already_queued"
  | "task_off"
  | "no_address"
  | "preference_off"
  | "refused";

const PURPOSE = "scheduled_tasks";

class EnqueueRefusal extends Error {}

export async function queueScheduledRunNotice(input: {
  runId: string;
  kind: ScheduledRunNoticeKind;
  env?: Record<string, string | undefined>;
  now?: Date;
}): Promise<ScheduledRunNoticeOutcome> {
  if (!scheduledTaskEmailEnabled(input.env ?? process.env)) return "switch_off";

  const run = await prisma.scheduledTaskRun.findUnique({
    where: { id: input.runId },
    select: {
      userId: true,
      startedAt: true,
      conversationId: true,
      noticeQueuedAt: true,
      task: { select: { title: true, timeZone: true, emailOnFinish: true, conversationId: true } },
      user: { select: { email: true, settings: { select: { language: true } } } },
    },
  });
  if (!run) return "not_found";
  if (run.noticeQueuedAt) return "already_queued";
  if (!run.task.emailOnFinish) return "task_off";
  const emailAddress = run.user.email;
  if (!emailAddress) return "no_address";

  const preference = await prisma.emailPreference.findUnique({
    where: { userId_purpose: { userId: run.userId, purpose: PURPOSE } },
    select: { enabled: true, confirmedAt: true },
  });
  const consent = consentGateVerdict({
    classification: "service",
    purpose: PURPOSE,
    hasAccount: true,
    storedEnabled: preference?.enabled ?? null,
    storedConfirmedAt: preference?.confirmedAt ?? null,
  });
  if (!consent.allowed) return "preference_off";

  const language = resolveEmailLanguage(run.user.settings?.language);
  const templateKey = input.kind === "answered" ? SCHEDULED_TASK_RUN_ANSWERED_TEMPLATE : SCHEDULED_TASK_PAUSED_TEMPLATE;
  // Registered before the transaction, so the enqueue inside it only reads.
  await ensureTemplateVersion({ templateKey, language });

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

  try {
    return await prisma.$transaction(async (tx) => {
      const claimed = await tx.scheduledTaskRun.updateMany({
        where: { id: input.runId, noticeQueuedAt: null },
        data: { noticeQueuedAt: input.now ?? new Date() },
      });
      if (!claimed.count) return "already_queued" as const;
      const queued = await enqueueStandardEmail({
        tx,
        templateKey,
        emailAddress,
        userId: run.userId,
        language,
        payload,
        referenceType: "scheduled_task_run",
        referenceId: input.runId,
      });
      // A refusal must not leave the run marked as notified.
      if (enqueueRefused(queued)) throw new EnqueueRefusal(queued.refused);
      return "queued" as const;
    });
  } catch (error) {
    if (error instanceof EnqueueRefusal) return "refused";
    throw error;
  }
}

/**
 * The runner's call: never throws. A notice that could not be queued is a
 * missing email, not a reason to leave a finished run open.
 */
export async function queueScheduledRunNoticeQuietly(input: { runId: string; kind: ScheduledRunNoticeKind }) {
  try {
    return await queueScheduledRunNotice(input);
  } catch (error) {
    console.error("Failed to queue a scheduled task notice:", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return "failed" as const;
  }
}
