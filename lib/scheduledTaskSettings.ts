import "server-only";

import { isE2EDatabaseDisabled } from "@/lib/e2eTestMode";
import {
  SCHEDULED_TASKS_FLAG_KEY,
  scheduledTasksAvailable,
  scheduledTasksKillSwitchEngaged,
} from "@/lib/scheduledTaskAccess";
import { prisma } from "@/lib/prisma";

/*
 * Kept out of lib/appSettings.ts for the reason lib/helpAssistantSettings.ts
 * gives: that file is in the Prompt Refiner runtime source closure.
 */

/** Whether scheduled tasks may be created and run. Unreadable is off. */
export async function isScheduledTasksEnabled(): Promise<boolean> {
  if (scheduledTasksKillSwitchEngaged(process.env)) return false;
  if (isE2EDatabaseDisabled()) return false;
  try {
    const row = await prisma.appSetting.findUnique({
      where: { key: SCHEDULED_TASKS_FLAG_KEY },
      select: { value: true },
    });
    return scheduledTasksAvailable({ storedFlagValue: row?.value, env: process.env });
  } catch {
    return false;
  }
}

/**
 * The Admin write path. Turning it on is the owner's approval of unattended
 * Chat turns paid from each account's own credits; turning it off stops new
 * runs at the next tick without a deploy. "true"/"false" only.
 */
export async function setScheduledTasksEnabled(enabled: boolean) {
  await prisma.appSetting.upsert({
    where: { key: SCHEDULED_TASKS_FLAG_KEY },
    update: { value: enabled ? "true" : "false" },
    create: { key: SCHEDULED_TASKS_FLAG_KEY, value: enabled ? "true" : "false" },
  });
}
