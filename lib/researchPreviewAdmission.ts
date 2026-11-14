import { canUseModelWithPlan, type AiModel, type ModelTier } from "./models";
import {
  appManagedSearchIsDispatchable,
  getWebSearchCapability,
} from "./webSearchCapability";
import type { WebSearchBackendReadiness } from "./webSearchBackends";

export const RESEARCH_PREVIEW_MAX_QUESTION_CHARACTERS = 4_000;
export const RESEARCH_PREVIEW_MAX_STEPS = 3;
export const RESEARCH_PREVIEW_MAX_SEARCH_ATTEMPTS = 5;
export const RESEARCH_PREVIEW_MAX_TOTAL_OUTPUT_TOKENS = 4_096;

export type ResearchPreviewOfferReason =
  | "ready"
  | "disabled"
  | "authentication_required"
  | "conversation_unavailable"
  | "conversation_locked"
  | "manual_single_model_required"
  | "plan_required"
  | "model_unavailable"
  | "model_ineligible"
  | "search_unavailable"
  | "profile_restricted";

export type ResearchPreviewAdmission = {
  offered: boolean;
  reason: ResearchPreviewOfferReason;
  limits?: {
    questionCharacters: typeof RESEARCH_PREVIEW_MAX_QUESTION_CHARACTERS;
    modelSteps: typeof RESEARCH_PREVIEW_MAX_STEPS;
    searchAttempts: typeof RESEARCH_PREVIEW_MAX_SEARCH_ATTEMPTS;
    totalOutputTokens: number;
  };
};

const configuredModelIds = (value: string | undefined) =>
  new Set(
    (value ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
  );

// P0 is deliberately narrower than the general app-managed search matrix.
// Each entry pins the provider API id whose AI SDK v7 usage reports reasoning
// inside outputTokens, which is what makes the run-wide output cap enforceable.
// An operator flag may select from this list; it cannot add another model.
export const RESEARCH_PREVIEW_P0_MODEL_SHORTLIST = [
  {
    id: "gemini-3-1-pro",
    provider: "google",
    apiModel: "gemini-3.1-pro-preview",
  },
] as const;

export const researchPreviewModelIsShortlisted = (
  model: Pick<AiModel, "id" | "provider" | "apiModel">
) => RESEARCH_PREVIEW_P0_MODEL_SHORTLIST.some(
  (entry) =>
    entry.id === model.id &&
    entry.provider === model.provider &&
    entry.apiModel === model.apiModel
);

export const researchPreviewGate = (
  model: Pick<AiModel, "id" | "provider" | "apiModel">,
  env: Record<string, string | undefined> = process.env
) =>
  env.RESEARCH_PREVIEW_ENABLED === "true" &&
  researchPreviewModelIsShortlisted(model) &&
  configuredModelIds(env.RESEARCH_PREVIEW_MODEL_IDS).has(model.id);

const refusal = (reason: Exclude<ResearchPreviewOfferReason, "ready">): ResearchPreviewAdmission => ({
  offered: false,
  reason,
});

/** One shared decision for the offer endpoint and paid dispatch admission. */
export function decideResearchPreviewAdmission(input: {
  signedIn: boolean;
  plan: ModelTier | null;
  conversationAvailable: boolean;
  conversationLocked: boolean;
  productKey: string | null;
  kind: string | null;
  selectionMode: string | null;
  selectedModelIds: readonly string[];
  model: AiModel | null;
  backendReadiness: WebSearchBackendReadiness;
  profileTools: { webSearch: boolean; deepResearch: boolean } | null;
  gateEnabled: boolean;
  modelOutputTokenCap: number;
}): ResearchPreviewAdmission {
  if (!input.gateEnabled) return refusal("disabled");
  if (!input.signedIn) return refusal("authentication_required");
  if (
    !input.conversationAvailable ||
    input.productKey !== "chat" ||
    input.kind !== "chat"
  ) return refusal("conversation_unavailable");
  if (input.conversationLocked) return refusal("conversation_locked");
  if (
    input.selectionMode !== "manual" ||
    input.selectedModelIds.length !== 1 ||
    input.selectedModelIds[0] !== input.model?.id
  ) return refusal("manual_single_model_required");
  if (!input.plan || !canUseModelWithPlan(input.plan, { minimumPlan: "Pro" })) {
    return refusal("plan_required");
  }
  if (!input.model?.enabled || input.model.catalogDeleted) {
    return refusal("model_unavailable");
  }
  if (!canUseModelWithPlan(input.plan, input.model)) return refusal("plan_required");
  if (!Number.isSafeInteger(input.modelOutputTokenCap) || input.modelOutputTokenCap <= 0) {
    return refusal("model_ineligible");
  }
  const capability = getWebSearchCapability(input.model);
  if (!appManagedSearchIsDispatchable(capability, input.backendReadiness)) {
    return refusal("search_unavailable");
  }
  if (
    input.profileTools &&
    (!input.profileTools.webSearch || !input.profileTools.deepResearch)
  ) return refusal("profile_restricted");
  const totalOutputTokens = Math.min(
    RESEARCH_PREVIEW_MAX_TOTAL_OUTPUT_TOKENS,
    input.modelOutputTokenCap
  );
  return {
    offered: true,
    reason: "ready",
    limits: {
      questionCharacters: RESEARCH_PREVIEW_MAX_QUESTION_CHARACTERS,
      modelSteps: RESEARCH_PREVIEW_MAX_STEPS,
      searchAttempts: RESEARCH_PREVIEW_MAX_SEARCH_ATTEMPTS,
      totalOutputTokens,
    },
  };
}

