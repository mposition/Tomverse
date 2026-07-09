import { DEFAULT_MODEL_ID, isEnabledModelId } from "@/lib/models";

export const APP_DEFAULTS = {
  defaultModelId: DEFAULT_MODEL_ID,
  defaultTheme: "dark",
  defaultLanguage: "en",

  maxSelectedModels: 3,
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
