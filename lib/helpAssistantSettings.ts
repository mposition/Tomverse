import "server-only";

import { isE2EDatabaseDisabled } from "@/lib/e2eTestMode";
import {
  HELP_ASSISTANT_FLAG_KEY,
  helpAssistantAvailable,
  helpAssistantKillSwitchEngaged,
} from "@/lib/helpAssistantAccess";
import { prisma } from "@/lib/prisma";

/*
 * Kept out of lib/appSettings.ts on purpose: that file is in the Prompt
 * Refiner's pinned runtime source closure, and a new import there would move
 * its file count and position snapshot.
 */

/** Whether the Help Centre question box makes a model call. Unreadable is off. */
export async function isHelpAssistantEnabled(): Promise<boolean> {
  if (helpAssistantKillSwitchEngaged(process.env)) return false;
  if (isE2EDatabaseDisabled()) return false;
  try {
    const row = await prisma.appSetting.findUnique({
      where: { key: HELP_ASSISTANT_FLAG_KEY },
      select: { value: true },
    });
    return helpAssistantAvailable({ storedFlagValue: row?.value, env: process.env });
  } catch {
    return false;
  }
}

/**
 * The Admin write path. The owner approved the paid call on 2026-11-18; this
 * switch is when it starts, and turning it off stops new calls without a
 * deploy. "true"/"false" only; a missing row is off.
 */
export async function setHelpAssistantEnabled(enabled: boolean) {
  await prisma.appSetting.upsert({
    where: { key: HELP_ASSISTANT_FLAG_KEY },
    update: { value: enabled ? "true" : "false" },
    create: { key: HELP_ASSISTANT_FLAG_KEY, value: enabled ? "true" : "false" },
  });
}
