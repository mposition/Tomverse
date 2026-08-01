import type { ProviderOptions } from "@ai-sdk/provider-utils";
import type { AiModel } from "@/lib/models";

// Google made these rules part of the contract for Gemini 3.6 Flash,
// Gemini 3.5 Flash-Lite, and later releases. Keep this exact allowlist next
// to the request helper so no generateText path can accidentally reintroduce
// sampling parameters for either stable Tomverse ID.
export const GEMINI_STRICT_GENERATION_MODEL_IDS = new Set([
  "gemini-3-6-flash",
  "gemini-2-5-flash",
]);

const supportsConfiguredReasoning = (model: Pick<AiModel, "id" | "provider">) =>
  model.provider === "openai" ||
  model.id === "groq-gpt-oss-120b" ||
  model.id === "grok-4-3" ||
  model.id === "grok-4-5";

export const getModelProviderOptions = (
  model: Pick<AiModel, "id" | "provider" | "reasoning">
): ProviderOptions | undefined => {
  if (model.reasoning === undefined || !supportsConfiguredReasoning(model)) {
    return undefined;
  }

  return {
    openai: {
      reasoningEffort: model.reasoning,
      // The OpenAI-compatible Groq/xAI IDs are intentionally not part of the
      // OpenAI SDK's own reasoning-model allowlist. This keeps the SDK from
      // dropping reasoning_effort before it reaches those providers.
      ...(model.provider === "openai" ? {} : { forceReasoning: true }),
    },
  };
};

export const getModelGenerationSettings = (
  model: Pick<AiModel, "id" | "provider" | "reasoning">,
  options?: { temperature?: number }
) => {
  const providerOptions = getModelProviderOptions(model);
  return {
    ...(options?.temperature !== undefined &&
    !GEMINI_STRICT_GENERATION_MODEL_IDS.has(model.id) &&
    model.reasoning === undefined
      ? { temperature: options.temperature }
      : {}),
    ...(providerOptions ? { providerOptions } : {}),
  };
};

export const hasUnsupportedGeminiPrefill = (
  model: Pick<AiModel, "id">,
  messages: readonly { role: string; content?: unknown }[]
) => {
  if (!GEMINI_STRICT_GENERATION_MODEL_IDS.has(model.id)) return false;
  const lastNonEmptyMessage = [...messages]
    .reverse()
    .find(
      (message) =>
        typeof message.content !== "string" || message.content.trim().length > 0
    );
  return lastNonEmptyMessage?.role === "assistant";
};
