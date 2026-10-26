import type { AvailableFrontierModel } from "./ideaFrontierCatalogUiCore.ts";
import type { AmuxIdeaModelSelection } from "./ideaFrontierSelectionCore.ts";

/**
 * The Admin idea input's per-idea model choice for unattended analysis (owner
 * decision 2026-10-23). The empty key keeps the operating scope's model, which
 * is the default and what coding sessions always use. Pure helpers: the server
 * still checks the choice against the approved catalog and the runner's CLI
 * channel before anything is written; the claim later needs its approved price.
 */
export type SessionModelChoice = { key: string; effort: string };

export const SESSION_MODEL_SCOPE_DEFAULT: SessionModelChoice = Object.freeze({ key: "", effort: "" });

export const sessionModelKey = (model: { provider: string; modelId: string }) =>
  `${model.provider}:${model.modelId}`;

/** The submit body's `model` field: null keeps the scope's model; "incomplete"
 * closes the submit button until a listed model and an allowed effort are set. */
export function sessionModelSelection(models: readonly AvailableFrontierModel[] | null,
  choice: SessionModelChoice): AmuxIdeaModelSelection | null | "incomplete" {
  if (choice.key === "") return null;
  const model = models?.find((entry) => sessionModelKey(entry) === choice.key);
  if (!model || !model.allowedEfforts.includes(choice.effort)) return "incomplete";
  return { provider: model.provider, modelId: model.modelId, reasoningEffort: choice.effort };
}

const EFFORT_ORDER = ["low", "medium", "high", "xhigh", "max", "ultra"];

/** Picking a model starts where the Frontier picker does: high when it is
 * allowed (the effort every launchable channel runs), else the highest. */
export function chooseSessionModel(models: readonly AvailableFrontierModel[] | null,
  key: string): SessionModelChoice {
  const model = models?.find((entry) => sessionModelKey(entry) === key);
  if (!model) return SESSION_MODEL_SCOPE_DEFAULT;
  const effort = model.allowedEfforts.includes("high") ? "high"
    : [...model.allowedEfforts].sort((left, right) =>
      EFFORT_ORDER.indexOf(right) - EFFORT_ORDER.indexOf(left))[0] ?? "";
  return { key, effort };
}
