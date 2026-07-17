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
};

const GUEST_DEFAULT_MODEL_KEY = "guestDefaultModelId";

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
  const row = await prisma.appSetting.findUnique({
    where: { key: GUEST_DEFAULT_MODEL_KEY },
    select: { value: true },
  });

  return {
    guestDefaultModelId: await normalizeGuestDefaultModel(row?.value),
  };
}

export async function updateGuestDefaultModel(modelId: string) {
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
