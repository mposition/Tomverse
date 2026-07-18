import "server-only";

import { APP_DEFAULTS } from "@/lib/appDefaults";
import {
  canUseModelWithPlan,
  getModelUsageProfile,
} from "@/lib/models";
import { getEnabledRuntimeModel } from "@/lib/modelRegistry";
import { prisma } from "@/lib/prisma";

export type PublicAppSettings = {
  guestDefaultModelId: string;
  aiChatEnabled: boolean;
  attachmentsEnabled: boolean;
  publicSharingEnabled: boolean;
};

const GUEST_DEFAULT_MODEL_KEY = "guestDefaultModelId";
const OPERATIONAL_FLAG_KEYS = {
  aiChatEnabled: "feature.aiChatEnabled",
  attachmentsEnabled: "feature.attachmentsEnabled",
  publicSharingEnabled: "feature.publicSharingEnabled",
} as const;

export type OperationalFeatureFlags = Pick<
  PublicAppSettings,
  "aiChatEnabled" | "attachmentsEnabled" | "publicSharingEnabled"
>;

const enabledFromValue = (value: string | null | undefined) => value !== "false";
const e2eDatabaseDisabled = () => process.env.E2E_DISABLE_DATABASE === "true";

export const isValidGuestDefaultModel = async (modelId: string) => {
  const model = await getEnabledRuntimeModel(modelId);
  return Boolean(
    model &&
      canUseModelWithPlan("Guest", model) &&
      getModelUsageProfile(model).category === "Standard"
  );
};

const normalizeGuestDefaultModel = async (modelId: string | null | undefined) =>
  modelId && (await isValidGuestDefaultModel(modelId))
    ? modelId
    : APP_DEFAULTS.guestDefaultModelId;

export async function getPublicAppSettings(): Promise<PublicAppSettings> {
  if (e2eDatabaseDisabled()) {
    return {
      guestDefaultModelId: APP_DEFAULTS.guestDefaultModelId,
      aiChatEnabled: true,
      attachmentsEnabled: true,
      publicSharingEnabled: true,
    };
  }
  const rows = await prisma.appSetting.findMany({
    where: {
      key: { in: [GUEST_DEFAULT_MODEL_KEY, ...Object.values(OPERATIONAL_FLAG_KEYS)] },
    },
    select: { key: true, value: true },
  });
  const values = new Map(rows.map((row) => [row.key, row.value]));

  return {
    guestDefaultModelId: await normalizeGuestDefaultModel(
      values.get(GUEST_DEFAULT_MODEL_KEY)
    ),
    aiChatEnabled: enabledFromValue(values.get(OPERATIONAL_FLAG_KEYS.aiChatEnabled)),
    attachmentsEnabled: enabledFromValue(
      values.get(OPERATIONAL_FLAG_KEYS.attachmentsEnabled)
    ),
    publicSharingEnabled: enabledFromValue(
      values.get(OPERATIONAL_FLAG_KEYS.publicSharingEnabled)
    ),
  };
}

export async function getOperationalFeatureFlags(): Promise<OperationalFeatureFlags> {
  const settings = await getPublicAppSettings();
  return {
    aiChatEnabled: settings.aiChatEnabled,
    attachmentsEnabled: settings.attachmentsEnabled,
    publicSharingEnabled: settings.publicSharingEnabled,
  };
}

export async function updateGuestDefaultModel(modelId: string) {
  if (e2eDatabaseDisabled()) return normalizeGuestDefaultModel(modelId);
  const normalized = await normalizeGuestDefaultModel(modelId);
  if (normalized !== modelId) {
    throw new Error(
      "Guest default model must be an enabled guest-accessible Standard model."
    );
  }

  await prisma.appSetting.upsert({
    where: { key: GUEST_DEFAULT_MODEL_KEY },
    create: {
      key: GUEST_DEFAULT_MODEL_KEY,
      value: modelId,
    },
    update: {
      value: modelId,
    },
  });

  return normalized;
}

export async function updatePublicAppSettings(settings: PublicAppSettings) {
  if (e2eDatabaseDisabled()) return settings;
  const guestDefaultModelId = await normalizeGuestDefaultModel(
    settings.guestDefaultModelId
  );
  if (guestDefaultModelId !== settings.guestDefaultModelId) {
    throw new Error(
      "Guest default model must be an enabled guest-accessible Standard model."
    );
  }
  await prisma.$transaction(
    [
      [GUEST_DEFAULT_MODEL_KEY, guestDefaultModelId],
      [OPERATIONAL_FLAG_KEYS.aiChatEnabled, String(settings.aiChatEnabled)],
      [OPERATIONAL_FLAG_KEYS.attachmentsEnabled, String(settings.attachmentsEnabled)],
      [OPERATIONAL_FLAG_KEYS.publicSharingEnabled, String(settings.publicSharingEnabled)],
    ].map(([key, value]) =>
      prisma.appSetting.upsert({
        where: { key },
        create: { key, value },
        update: { value },
      })
    )
  );
  return getPublicAppSettings();
}

export class OperationalFeatureDisabledError extends Error {
  constructor(public feature: keyof OperationalFeatureFlags) {
    super(`The ${feature} feature is temporarily disabled by an administrator.`);
    this.name = "OperationalFeatureDisabledError";
  }
}

export async function assertOperationalFeatureEnabled(
  feature: keyof OperationalFeatureFlags
) {
  const flags = await getOperationalFeatureFlags();
  if (!flags[feature]) throw new OperationalFeatureDisabledError(feature);
}
