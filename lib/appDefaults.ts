import {
  canUseModelWithPlan,
  DEFAULT_MODEL_ID,
  getModel,
  getModelUsageProfile,
  isEnabledModelId,
} from "@/lib/models";

const GUEST_DEFAULT_MODEL_ID = "gemini-2-5-flash";

// The two other most recognizable frontier brands, so a guest's first chat
// immediately shows Tomverse's core comparison value instead of a single
// generic answer. The admin-configurable guestDefaultModelId (AppSetting)
// still leads the trio — see getGuestDefaultSelectedModels.
export const GUEST_COMPANION_MODEL_IDS = ["gpt-5-4-mini", "claude-haiku-4-5"];

const isGuestEligibleModel = (modelId: string) => {
  const model = getModel(modelId);
  return Boolean(
    model?.enabled &&
      canUseModelWithPlan("Guest", model) &&
      getModelUsageProfile(model).category === "Standard"
  );
};

if (!isEnabledModelId(GUEST_DEFAULT_MODEL_ID) || !isGuestEligibleModel(GUEST_DEFAULT_MODEL_ID)) {
  throw new Error("Guest default model must be an enabled guest-accessible Standard model.");
}

for (const modelId of GUEST_COMPANION_MODEL_IDS) {
  if (!isEnabledModelId(modelId) || !isGuestEligibleModel(modelId)) {
    throw new Error(`Guest companion model must be an enabled guest-accessible Standard model: ${modelId}`);
  }
}

export const APP_DEFAULTS = {
  defaultModelId: DEFAULT_MODEL_ID,
  guestDefaultModelId: GUEST_DEFAULT_MODEL_ID,
  defaultTheme: "dark",
  defaultLanguage: "en",

  maxSelectedModels: 3,
  maxGuestSelectedModels: 3,
  maxGuestMessages: 20,

  guestDateStorageKey: "guest_date",
  guestCountStorageKey: "guest_count",

  guestChatId: "guest-chat",
  privateChatId: "private-chat",
} as const;

export const getDefaultSelectedModels = () => [APP_DEFAULTS.defaultModelId];

export const clampSelectedModels = (models: string[]) =>
  Array.from(new Set(models))
    .filter(isEnabledModelId)
    .slice(0, APP_DEFAULTS.maxSelectedModels);

export const clampGuestSelectedModels = (models: string[]) =>
  clampSelectedModels(models).filter(
    isGuestEligibleModel
  ).slice(0, APP_DEFAULTS.maxGuestSelectedModels);

export const getGuestDefaultSelectedModels = (
  primaryModelId: string = APP_DEFAULTS.guestDefaultModelId
) =>
  clampGuestSelectedModels(
    Array.from(new Set([primaryModelId, ...GUEST_COMPANION_MODEL_IDS]))
  );
