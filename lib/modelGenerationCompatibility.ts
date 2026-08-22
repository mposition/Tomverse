import type { ProviderOptions } from "@ai-sdk/provider-utils";
import type { AiModel } from "@/lib/models";

// Google made these rules part of the contract for Gemini 3.6 Flash,
// Gemini 3.5 Flash-Lite, and later releases. Keep this exact allowlist next
// to the request helper so no generateText path can accidentally reintroduce
// sampling parameters for any stable Tomverse ID on that line.
export const GEMINI_STRICT_GENERATION_MODEL_IDS = new Set([
  "gemini-3-7-flash",
  "gemini-3-6-flash",
  "gemini-2-5-flash",
]);

export const getModelProviderOptions = (
  model: Pick<AiModel, "id" | "provider" | "reasoning">
): ProviderOptions | undefined => {
  if (model.reasoning === undefined) {
    return undefined;
  }

  if (model.provider === "anthropic") {
    return {
      anthropic: {
        thinking: { type: "adaptive" },
        effort: model.reasoning,
      },
    };
  }

  if (model.provider === "minimax") {
    return {
      anthropic: {
        // MiniMax supports adaptive thinking on its Anthropic-compatible
        // endpoint, but not Anthropic's separate `effort` field.
        thinking: { type: "adaptive" },
      },
    };
  }

  if (model.provider === "moonshot") {
    return {
      moonshotai: {
        reasoningEffort: model.reasoning,
      },
    };
  }

  const usesOpenAiReasoning =
    model.provider === "openai" ||
    model.id === "grok-4-3" ||
    model.id === "grok-4-5";
  if (!usesOpenAiReasoning) return undefined;

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
