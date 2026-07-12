import {
  DEFAULT_MODEL_ID,
  getModel,
  isEnabledModelId,
} from "@/lib/models";

const GUEST_DEFAULT_MODEL_ID = "gemini-2-5-flash";

if (
  !isEnabledModelId(GUEST_DEFAULT_MODEL_ID) ||
  getModel(GUEST_DEFAULT_MODEL_ID)?.tier !== "Free"
) {
  throw new Error("Guest default model must be an enabled Free model.");
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
    (modelId) => getModel(modelId)?.tier === "Free"
  ).slice(0, APP_DEFAULTS.maxGuestSelectedModels);
