import type { AiModel } from "@/lib/models";

export type ReasoningEffort = "low" | "default" | "high";
export type ExplicitReasoningEffort = Exclude<ReasoningEffort, "default">;
/**
 * The ordered steps a model can be asked for when the Desktop steps switch is on. `medium` is only ever requested
 * by a Desktop turn or a coding API request; the web picker keeps its two explicit presets.
 */
export type ReasoningEffortStep = ExplicitReasoningEffort | "medium";
/** What a reply reports it applied: a step, or `default` when none was sent. */
export type AppliedReasoningEffort = ReasoningEffort | ReasoningEffortStep;

const levels: readonly ExplicitReasoningEffort[] = ["low", "high"];
const steps: readonly ReasoningEffortStep[] = ["low", "medium", "high"];

export const isExplicitReasoningEffort = (value: unknown): value is ExplicitReasoningEffort =>
    value === "low" || value === "high";

export const isReasoningEffortStep = (value: unknown): value is ReasoningEffortStep =>
    value === "low" || value === "medium" || value === "high";

// Match both the provider and exact upstream ID: Admin can remap a Tomverse ID.
export const modelReasoningEfforts = (
    model: Pick<AiModel, "provider" | "apiModel" | "reasoning">
): readonly ExplicitReasoningEffort[] =>
    ((model.provider === "openai" && model.apiModel === "gpt-6-luna") ||
    (model.provider === "anthropic" && model.apiModel === "claude-haiku-5-5")) &&
    model.reasoning !== undefined && model.reasoning !== "none" ? levels : [];

/**
 * The same models, with every step their provider takes. A model that offers no effort offers no step either, and
 * the credit price of a request does not depend on the step (the model's own weight decides it).
 */
export const modelReasoningEffortSteps = (
    model: Pick<AiModel, "provider" | "apiModel" | "reasoning">
): readonly ReasoningEffortStep[] => modelReasoningEfforts(model).length > 0 ? steps : [];

export const reasoningEffortEnabled = () => process.env.TOMVERSE_REASONING_EFFORT_ENABLED === "true";

/** Default off. The steps ride on the effort switch: with that off there is no effort at all. */
export const reasoningEffortStepsEnabled = () =>
    reasoningEffortEnabled() && process.env.TOMVERSE_DESKTOP_REASONING_STEPS_ENABLED === "true";

/** What a request may ask for and what a catalogue lists: the steps while their switch is on, else the two presets. */
export const modelReasoningEffortOptions = (
    model: Pick<AiModel, "provider" | "apiModel" | "reasoning">
): readonly ReasoningEffortStep[] => reasoningEffortStepsEnabled() ? modelReasoningEffortSteps(model) : modelReasoningEfforts(model);

export const modelWithReasoningEffort = <T extends Pick<AiModel, "reasoning">>(
    model: T, effort?: ReasoningEffortStep
): T => effort === undefined ? model : { ...model, reasoning: effort };
