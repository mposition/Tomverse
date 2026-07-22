import {
  canUseModelWithPlan,
  DEFAULT_MODEL_ID,
  getModel,
  getModelUsageProfile,
  isEnabledModelId,
} from "@/lib/models";

const GUEST_DEFAULT_MODEL_ID = "gemini-2-5-flash";

// The three most recognizable frontier brands, shown for every guest so
// their first chat immediately demonstrates Tomverse's core comparison
// value. This trio is always guaranteed regardless of the admin-configured
// guestDefaultModelId (AppSetting) below — that setting only controls which
// of these three leads (see getGuestDefaultSelectedModels); it has no effect
// if it names a model outside the trio.
export const GUEST_BRAND_TRIO_MODEL_IDS = ["gpt-5-4-mini", "claude-haiku-4-5", "gemini-2-5-flash"];

// Backstops used only if one of the brand trio above is itself disabled or
// ineligible, so the guest default still comes out to 3 distinct models
// instead of silently collapsing via Set dedup.
export const GUEST_FALLBACK_MODEL_IDS = ["llama-3-1", "grok-3-mini", "deepseek-v4-flash"];

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

for (const modelId of GUEST_BRAND_TRIO_MODEL_IDS) {
  if (!isEnabledModelId(modelId) || !isGuestEligibleModel(modelId)) {
    throw new Error(`Guest brand-trio model must be an enabled guest-accessible Standard model: ${modelId}`);
  }
}

for (const modelId of GUEST_FALLBACK_MODEL_IDS) {
  if (!isEnabledModelId(modelId) || !isGuestEligibleModel(modelId)) {
    throw new Error(`Guest fallback model must be an enabled guest-accessible Standard model: ${modelId}`);
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

// Always includes the GPT/Claude/Gemini brand trio, backfilling from
// GUEST_FALLBACK_MODEL_IDS if one of them is disabled. leadModelId (the
// admin-configured guestDefaultModelId) only reorders which of the three
// appears first, and is ignored if it names a model outside the trio.
export const getGuestDefaultSelectedModels = (
  leadModelId: string = APP_DEFAULTS.guestDefaultModelId
) => {
  const orderedTrio = GUEST_BRAND_TRIO_MODEL_IDS.includes(leadModelId)
    ? [leadModelId, ...GUEST_BRAND_TRIO_MODEL_IDS.filter((id) => id !== leadModelId)]
    : GUEST_BRAND_TRIO_MODEL_IDS;

  const trio: string[] = [];
  for (const modelId of [...orderedTrio, ...GUEST_FALLBACK_MODEL_IDS]) {
    if (trio.includes(modelId) || !isGuestEligibleModel(modelId)) continue;
    trio.push(modelId);
    if (trio.length >= 3) break;
  }
  return clampGuestSelectedModels(trio);
};
