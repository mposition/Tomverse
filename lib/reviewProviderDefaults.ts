import "server-only";

import type { Session } from "next-auth";
import { prisma } from "@/lib/prisma";
import { writeAdminAuditLog } from "@/lib/adminAudit";
import { isE2EDatabaseDisabled } from "@/lib/e2eTestMode";
import { getRuntimeModels } from "@/lib/modelRegistry";
import {
  parseReviewProviderDefaults, REVIEW_DEFAULT_PROVIDERS,
  REVIEW_DEFAULT_PROVIDERS_KEY, reviewProviderOptions,
} from "@/lib/reviewProviderPreferencesCore";

export async function getPlatformReviewProviderDefaults(): Promise<string[]> {
  if (isE2EDatabaseDisabled()) return [...REVIEW_DEFAULT_PROVIDERS];
  const row = await prisma.appSetting.findUnique({
    where: { key: REVIEW_DEFAULT_PROVIDERS_KEY }, select: { value: true },
  });
  try { return parseReviewProviderDefaults(JSON.parse(row?.value ?? "null")) ?? [...REVIEW_DEFAULT_PROVIDERS]; }
  catch { return [...REVIEW_DEFAULT_PROVIDERS]; }
}

export async function getAdminReviewProviderDefaults() {
  const [providers, models] = await Promise.all([getPlatformReviewProviderDefaults(), getRuntimeModels()]);
  return { reviewEasyDefaultProviders: providers, reviewEasyProviderOptions: reviewProviderOptions(models, "Max") };
}

/** The owning route supplies its existing ops:write and recent-auth admission. */
export async function updatePlatformReviewProviderDefaults(providers: string[], session: Session, request: Request) {
  await prisma.$transaction(async tx => {
    const value = JSON.stringify(providers);
    await tx.appSetting.upsert({
      where: { key: REVIEW_DEFAULT_PROVIDERS_KEY },
      create: { key: REVIEW_DEFAULT_PROVIDERS_KEY, value }, update: { value },
    });
    await writeAdminAuditLog({
      session, request, tx, action: "app_settings.review_defaults.update_completed",
      targetType: "AppSettings", targetId: REVIEW_DEFAULT_PROVIDERS_KEY,
      summary: "Updated the default providers for new Easy Reviews.", metadata: { providers },
    });
  });
}
