import "server-only";

import { APP_DEFAULTS, guestDefaultLeadRejection } from "@/lib/appDefaults";
import { isE2EDatabaseDisabled } from "@/lib/e2eTestMode";
import {
  canUseModelWithPlan,
  getModelUsageProfile,
} from "@/lib/models";
import { getEnabledRuntimeModel } from "@/lib/modelRegistry";
import { prisma } from "@/lib/prisma";
import { invalidatePublicSnapshot } from "@/lib/publicSnapshotCache";

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
const e2eDatabaseDisabled = isE2EDatabaseDisabled;

/**
 * Why a value may not be stored here. The rule itself lives in
 * `guestDefaultLeadRejection` (pure, so it can be tested without a database);
 * this resolves the model against the runtime registry and applies it.
 *
 * The part worth knowing: eligibility is not enough. This setting only
 * reorders the guest brand trio, so a model outside it saves cleanly, reads
 * back, is served by `/api/app-settings`, and changes nothing a guest ever
 * sees. That is rejected rather than accepted.
 */
export const guestDefaultModelRejection = async (
  modelId: string
): Promise<string | null> => {
  const model = await getEnabledRuntimeModel(modelId);
  return guestDefaultLeadRejection({
    modelId,
    exists: Boolean(model),
    guestEligible: Boolean(model && canUseModelWithPlan("Guest", model)),
    usageCategory: model ? getModelUsageProfile(model).category : null,
  });
};

export const isValidGuestDefaultModel = async (modelId: string) =>
  (await guestDefaultModelRejection(modelId)) === null;

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
  const rejection = await guestDefaultModelRejection(modelId);
  if (rejection) throw new Error(`Guest default model rejected: ${rejection}`);
  const normalized = modelId;

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
  // SEC-012. `/api/app-settings` answers from a shared snapshot; without this
  // the console would show its own change as unapplied until the TTL lapsed.
  invalidatePublicSnapshot("app-settings");

  return normalized;
}

export async function updatePublicAppSettings(settings: PublicAppSettings) {
  if (e2eDatabaseDisabled()) return settings;
  const rejection = await guestDefaultModelRejection(
    settings.guestDefaultModelId
  );
  if (rejection) throw new Error(`Guest default model rejected: ${rejection}`);
  const guestDefaultModelId = settings.guestDefaultModelId;
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
  invalidatePublicSnapshot("app-settings");
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
