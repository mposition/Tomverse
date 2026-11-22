import type { AiModel } from "@/lib/models";

export type ReasoningEffort = "low" | "default" | "high";
export type ExplicitReasoningEffort = Exclude<ReasoningEffort, "default">;

const levels: readonly ExplicitReasoningEffort[] = ["low", "high"];

export const isExplicitReasoningEffort = (value: unknown): value is ExplicitReasoningEffort =>
    value === "low" || value === "high";

// Match both the provider and exact upstream ID: Admin can remap a Tomverse ID.
export const modelReasoningEfforts = (
    model: Pick<AiModel, "provider" | "apiModel" | "reasoning">
): readonly ExplicitReasoningEffort[] =>
    ((model.provider === "openai" && model.apiModel === "gpt-6-luna") ||
    (model.provider === "anthropic" && model.apiModel === "claude-haiku-5-5")) &&
    model.reasoning !== undefined && model.reasoning !== "none" ? levels : [];

export const reasoningEffortEnabled = () => process.env.TOMVERSE_REASONING_EFFORT_ENABLED === "true";

export const modelWithReasoningEffort = <T extends Pick<AiModel, "reasoning">>(
    model: T, effort?: ExplicitReasoningEffort
): T => effort === undefined ? model : { ...model, reasoning: effort };
