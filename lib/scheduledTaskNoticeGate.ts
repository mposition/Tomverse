import "server-only";

import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";

/**
 * Whether a scheduled task's result email is still wanted by its task: the
 * task exists and its own "email me when it finishes" switch is on.
 *
 * Asked twice (lib/scheduledTaskNotice.ts): inside the transaction that queues
 * the notice, with the task row locked so a settings save either commits
 * before and is seen, or waits until the notice is queued; and again by the
 * standard lane immediately before it sends (lib/standardEmailLane.ts), beside
 * the account's purpose check, because the switch may be turned off -- or the
 * task deleted -- after the message was queued.
 *
 * Its own module so the lane can ask without importing the module that
 * enqueues through the lane.
 */

export const SCHEDULED_TASK_NOTICE_PURPOSE = "scheduled_tasks";
export const SCHEDULED_TASK_NOTICE_REFERENCE = "scheduled_task_run";

export type ScheduledTaskNoticeWanted = "wanted" | "task_email_off" | "task_deleted";

export async function scheduledTaskNoticeWanted(
  runId: string | null | undefined,
  options: { tx?: Prisma.TransactionClient; lock?: boolean } = {}
): Promise<ScheduledTaskNoticeWanted> {
  if (!runId) return "task_deleted";
  const client = options.tx ?? prisma;
  // Runs cascade with their task, so a missing run is a deleted task (or account).
  const rows = options.lock
    ? await client.$queryRaw<Array<{ emailOnFinish: boolean }>>`
        SELECT t."emailOnFinish" FROM "ScheduledTaskRun" r
        JOIN "ScheduledTask" t ON t."id" = r."taskId"
        WHERE r."id" = ${runId}
        FOR UPDATE OF t`
    : await client.$queryRaw<Array<{ emailOnFinish: boolean }>>`
        SELECT t."emailOnFinish" FROM "ScheduledTaskRun" r
        JOIN "ScheduledTask" t ON t."id" = r."taskId"
        WHERE r."id" = ${runId}`;
  const row = rows[0];
  if (!row) return "task_deleted";
  return row.emailOnFinish ? "wanted" : "task_email_off";
}
