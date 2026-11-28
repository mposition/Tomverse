import "server-only";

import { getOperationalFeatureFlags } from "@/lib/appSettings";
import { ARTIFACT_SHARING_FLAG_KEY, artifactSharingAvailable } from "@/lib/artifactShareAccess";
import { isE2EDatabaseDisabled } from "@/lib/e2eTestMode";
import { prisma } from "@/lib/prisma";

/*
 * Kept out of lib/appSettings.ts for the reason lib/helpAssistantSettings.ts
 * gives: that file is in the Prompt Refiner runtime source closure.
 */

/** The stored switch on its own, as the Admin panel shows it. Unreadable is off. */
export async function isArtifactSharingSwitchOn(): Promise<boolean> {
  if (isE2EDatabaseDisabled()) return false;
  try {
    const row = await prisma.appSetting.findUnique({ where: { key: ARTIFACT_SHARING_FLAG_KEY }, select: { value: true } });
    return row?.value === "true";
  } catch {
    return false;
  }
}

/**
 * Whether share links may be made and opened: this switch on, and public
 * sharing not stopped for maintenance. The public page reads it on every
 * request, so turning either off takes every existing link down at once.
 * Unreadable is off.
 */
export async function isArtifactSharingEnabled(): Promise<boolean> {
  if (isE2EDatabaseDisabled()) return false;
  try {
    const [row, flags] = await Promise.all([
      prisma.appSetting.findUnique({ where: { key: ARTIFACT_SHARING_FLAG_KEY }, select: { value: true } }),
      getOperationalFeatureFlags(),
    ]);
    return artifactSharingAvailable({ storedFlagValue: row?.value, publicSharingEnabled: flags.publicSharingEnabled });
  } catch {
    return false;
  }
}

/**
 * The Admin write path. Turning it on is the owner's approval of public pages
 * made from people's previews (content leaving the account); turning it off
 * takes every link down without a deploy. "true"/"false" only.
 */
export async function setArtifactSharingEnabled(enabled: boolean) {
  await prisma.appSetting.upsert({
    where: { key: ARTIFACT_SHARING_FLAG_KEY },
    update: { value: enabled ? "true" : "false" },
    create: { key: ARTIFACT_SHARING_FLAG_KEY, value: enabled ? "true" : "false" },
  });
}
