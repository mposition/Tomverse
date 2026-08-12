import {
  canUseModelWithPlan,
  DEFAULT_MODEL_ID,
  getModel,
  getModelUsageProfile,
  isEnabledModelId,
  type AiModel,
} from "@/lib/models";

// Kept in step with DEFAULT_MODEL_ID so a guest's leading model is the same
// model a signed-in account gets by default. It was gemini-2-5-flash while
// the app default was gpt-5-4-mini; both moved to gpt-5-6-luna on 2026-08-01.
// Operational deployments may still hold an older guestDefaultModelId in
// AppSetting -- prisma/migrations/20260801200000_default_model_gpt_5_6_luna
// realigns that exact key rather than relying on this constant alone.
const GUEST_DEFAULT_MODEL_ID = "gpt-5-6-luna";

// The three most recognizable frontier brands, shown for every guest so
// their first chat immediately demonstrates Tomverse's core comparison
// value. This trio is always guaranteed regardless of the admin-configured
// guestDefaultModelId (AppSetting) below — that setting only controls which
// of these three leads (see getGuestDefaultSelectedModels); it has no effect
// if it names a model outside the trio.
//
// The OpenAI slot moved from gpt-5-4-mini to gpt-5-6-luna with the default
// switch. Both are Guest-tier Standard models at 1 credit, so the trio still
// costs a guest exactly 3 credits per comparison.
export const GUEST_BRAND_TRIO_MODEL_IDS = ["gpt-5-6-luna", "claude-haiku-4-5", "gemini-2-5-flash"];

// Backstops used only if one of the brand trio above is itself disabled or
// ineligible, so the guest default still comes out to 3 distinct models
// instead of silently collapsing via Set dedup.
export const GUEST_FALLBACK_MODEL_IDS = ["deepseek-v4-flash", "mistral-small-4", "qwen3.6-flash"];

/** Resolves a model id against whichever catalogue the caller is holding. */
export type ModelLookup = (modelId: string) => AiModel | undefined;

// The single definition of "a guest may select this model". Parameterised by
// the catalogue lookup so the static import-time catalogue (below) and the
// runtime, DB-backed one (components/ModelCatalogProvider) apply exactly the
// same rule -- the guest default must never come out differently depending
// on which catalogue happened to answer.
export const createGuestEligibilityCheck =
  (lookup: ModelLookup) => (modelId: string) => {
    const model = lookup(modelId);
    return Boolean(
      model?.enabled &&
        !model.catalogDeleted &&
        canUseModelWithPlan("Guest", model) &&
        getModelUsageProfile(model).category === "Standard"
    );
  };

const isGuestEligibleModel = createGuestEligibilityCheck(getModel);

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

  defaultWebSearchMode: "off",
} as const;

// Per-conversation, not per-message -- see components/chat/ChatInput.tsx's
// tools sheet. "auto" only ever triggers a dismissible inline suggestion,
// it never sends a search request on its own.
export const WEB_SEARCH_MODES = ["off", "auto", "always"] as const;
export type WebSearchMode = (typeof WEB_SEARCH_MODES)[number];
export const isWebSearchMode = (value: unknown): value is WebSearchMode =>
  typeof value === "string" && (WEB_SEARCH_MODES as readonly string[]).includes(value);

export const getDefaultSelectedModels = () => [APP_DEFAULTS.defaultModelId];

export const clampSelectedModels = (models: string[]) =>
  Array.from(new Set(models))
    .filter(isEnabledModelId)
    .slice(0, APP_DEFAULTS.maxSelectedModels);

export const clampGuestSelectedModels = (models: string[]) =>
  clampSelectedModels(models).filter(
    isGuestEligibleModel
  ).slice(0, APP_DEFAULTS.maxGuestSelectedModels);

// THE guest default selection. Always includes the GPT/Claude/Gemini brand
// trio, backfilling from GUEST_FALLBACK_MODEL_IDS if one of them is
// ineligible so the default is still 3 distinct models. leadModelId (the
// admin-configured guestDefaultModelId) only reorders which of the three
// appears first, and is ignored if it names a model outside the trio.
//
// Deliberately pure and catalogue-injected: the server
// (app/(site)/(application)/chat/page.tsx via lib/appSettings) and the client's
// very first render (app/(site)/(application)/chat/ChatPageClient.tsx) both
// call this, so the guest model count -- and therefore the estimated credits
// derived from it -- is identical before and after hydration (STG-F006).
export const resolveGuestDefaultSelectedModels = ({
  isEligible,
  leadModelId = APP_DEFAULTS.guestDefaultModelId,
  maxModels = APP_DEFAULTS.maxGuestSelectedModels,
}: {
  isEligible: (modelId: string) => boolean;
  leadModelId?: string;
  maxModels?: number;
}) => {
  const orderedTrio = GUEST_BRAND_TRIO_MODEL_IDS.includes(leadModelId)
    ? [leadModelId, ...GUEST_BRAND_TRIO_MODEL_IDS.filter((id) => id !== leadModelId)]
    : GUEST_BRAND_TRIO_MODEL_IDS;

  const trio: string[] = [];
  for (const modelId of [...orderedTrio, ...GUEST_FALLBACK_MODEL_IDS]) {
    if (trio.includes(modelId) || !isEligible(modelId)) continue;
    trio.push(modelId);
    if (trio.length >= maxModels) break;
  }
  return trio;
};

/**
 * Why a model may not be stored as `AppSetting["guestDefaultModelId"]`, or
 * `null` when it may. Pure, so the rule can be checked without a database.
 *
 * The last clause is the one that matters and the one that used to be
 * missing. This setting does exactly one thing -- reorder the brand trio --
 * so a model outside the trio is dropped by `resolveGuestDefaultSelectedModels`
 * above. Storing one succeeded, read back, and served through
 * `/api/app-settings` while changing nothing a guest ever saw: an
 * administrator had no way to tell a setting that works from a setting that
 * silently does not. Which three models guests see is a product decision that
 * moves `GUEST_BRAND_TRIO_MODEL_IDS` together with the picker, the credit
 * estimate and the E2E expectations -- not something this setting can do from
 * the side.
 */
export const guestDefaultLeadRejection = ({
  modelId,
  exists,
  guestEligible,
  usageCategory,
}: {
  modelId: string;
  exists: boolean;
  guestEligible: boolean;
  usageCategory: string | null;
}): string | null => {
  if (!exists) return `"${modelId}" is not an enabled model.`;
  if (!guestEligible) return `"${modelId}" is not available to guests.`;
  if (usageCategory !== "Standard") {
    return `"${modelId}" is priced as ${usageCategory ?? "unknown"}, not Standard, so a guest could not pay for it.`;
  }
  if (!GUEST_BRAND_TRIO_MODEL_IDS.includes(modelId)) {
    return (
      `"${modelId}" is not one of the guest brand trio (${GUEST_BRAND_TRIO_MODEL_IDS.join(", ")}), ` +
      "so it would be stored but never applied: this setting only chooses which of those three leads."
    );
  }
  return null;
};

export const getGuestDefaultSelectedModels = (
  leadModelId: string = APP_DEFAULTS.guestDefaultModelId
) =>
  clampGuestSelectedModels(
    resolveGuestDefaultSelectedModels({
      isEligible: isGuestEligibleModel,
      leadModelId,
    })
  );
