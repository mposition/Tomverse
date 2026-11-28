import type { ProviderOptions } from "@ai-sdk/provider-utils";
import type { AiModel } from "@/lib/models";
import {
  anthropicPromptCacheOptions,
  type AnthropicPromptCachePath,
} from "@/lib/anthropicPromptCaching";

// Google made these rules part of the contract for Gemini 3.6 Flash,
// Gemini 3.5 Flash-Lite, and later releases. Keep this exact allowlist next
// to the request helper so no generateText path can accidentally reintroduce
// sampling parameters for any stable Tomverse ID on that line.
export const GEMINI_STRICT_GENERATION_MODEL_IDS = new Set([
  "gemini-3-7-flash",
  "gemini-3-6-flash",
  "gemini-2-5-flash",
  "gemini-flash-lite-latest",
]);

type GenerationModel = Pick<AiModel, "id" | "provider" | "reasoning" | "apiModel">;

export const getModelProviderOptions = (
  model: GenerationModel
): ProviderOptions | undefined => {
  // M3.1 Flash always thinks and defaults to max effort if omitted. Honour
  // the catalogue effort so a short answer budget is not all spent thinking.
  // Match the upstream ID: a stable Tomverse ID can be remapped in Admin.
  if (model.provider === "minimax" && model.apiModel?.toLowerCase() === "minimax-m3.1-flash") {
    return {
      anthropic: {
        thinking: { type: "adaptive" },
        effort: model.reasoning === "none" ? "low" : model.reasoning ?? "medium",
      },
    };
  }

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
        // M3 supports adaptive thinking, but only M3.1 Flash accepts effort.
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

/**
 * Two provider-options objects, merged one namespace deep.
 *
 * A shallow spread is wrong here and quietly so: `providerOptions` is keyed by
 * provider namespace and every value under a namespace is a sibling, so
 * `{...base, ...overlay}` replaces the whole `openai` object rather than adding
 * to it. That is how a request ends up carrying `maxToolCalls` and no
 * `reasoningEffort` -- both were set, in the same namespace, by two callers
 * that never saw each other.
 */
export const mergeProviderOptions = (
  base: ProviderOptions | undefined,
  overlay: ProviderOptions | undefined
): ProviderOptions | undefined => {
  if (!base) return overlay;
  if (!overlay) return base;
  const merged: ProviderOptions = { ...base };
  for (const [namespace, values] of Object.entries(overlay)) {
    merged[namespace] = { ...(merged[namespace] ?? {}), ...values };
  }
  return merged;
};

/**
 * The request option that asks a provider for a summary of the reasoning it
 * already does, so Chat can show it (lib/chatReasoningDisplay.ts).
 *
 * It adds nothing to a model that is not reasoning and changes neither whether
 * nor how much a model reasons: each option below only decides whether the
 * summary is sent back. Anthropic bills the full thinking whatever `display`
 * says and charges nothing for the summary; OpenAI's usage reports reasoning
 * tokens the same with or without a summary; Google bills thinking tokens the
 * same with `includeThoughts`. A provider not listed here either already
 * returns its reasoning (Moonshot) or has no summary option this adapter can
 * send (the OpenAI-compatible chat adapter drops `reasoning_content`).
 *
 * `reasoning === "none"` is left alone on purpose: that is a model told not to
 * think, and there is nothing to summarise.
 */
export const getReasoningSummaryProviderOptions = (
  model: GenerationModel
): ProviderOptions | undefined => {
  if (model.reasoning === "none") return undefined;
  if (model.provider === "anthropic" && model.reasoning !== undefined) {
    // `display: "summarized"` returns the thinking text the SDK then streams as
    // reasoning parts. Newer Claude models default to "omitted" (an empty
    // thinking block), which still tells Chat the model is thinking.
    return { anthropic: { thinking: { type: "adaptive", display: "summarized" } } };
  }
  if (model.provider === "openai" && model.reasoning !== undefined) {
    // Responses API `reasoning.summary`. "auto" is the most detailed summary
    // the model supports. OpenAI may require organization verification.
    return { openai: { reasoningSummary: "auto" } };
  }
  if (model.provider === "google") {
    // Gemini thinks by default; this only returns the thought summary.
    return { google: { thinkingConfig: { includeThoughts: true } } };
  }
  return undefined;
};

export const getModelGenerationSettings = (
  model: GenerationModel,
  options?: {
    /**
     * Ask the provider for a summary of the reasoning it is already doing.
     * Off unless the caller turns it on (CHAT_REASONING_DISPLAY_ENABLED).
     */
    reasoningSummary?: boolean;
    temperature?: number;
    /**
     * OpenAI's `max_tool_calls` for this request, when the turn is dispatching
     * OpenAI's native web search.
     *
     * Passed in rather than derived here because the ceiling belongs to the
     * web-search capability, not to the model's generation profile, and
     * because it must be absent on every turn that is not searching -- a
     * request that is not attaching the tool has no built-in tool calls to
     * bound and should send no parameter bounding them. Callers get it from
     * `openAiNativeSearchToolCallCeiling`, which reads the same capability
     * field the cost reservation is sized on.
     */
    openAiMaxToolCalls?: number;
    /**
     * Which call path this request is, for Anthropic prompt caching.
     *
     * Required to get a cache marker and absent by default, so a new call site
     * caches only once somebody has named it in
     * `ANTHROPIC_PROMPT_CACHE_PATHS` with the repeated prefix it has. The
     * opposite default -- cache unless told not to -- would have turned the
     * health probe and the conversation-title call into cache writes nothing
     * reads, and would have done it silently.
     */
    promptCachePath?: AnthropicPromptCachePath;
  }
) => {
  const providerOptions = mergeProviderOptions(
    mergeProviderOptions(
      mergeProviderOptions(
        getModelProviderOptions(model),
        options?.reasoningSummary ? getReasoningSummaryProviderOptions(model) : undefined
      ),
      // Merged rather than assigned: a reasoning OpenAI model already has an
      // `openai` namespace holding `reasoningEffort`, and this has to land
      // beside it. It also has to be reachable on a model with no reasoning
      // profile at all, where `getModelProviderOptions` returns undefined.
      options?.openAiMaxToolCalls !== undefined &&
        options.openAiMaxToolCalls > 0
        ? { openai: { maxToolCalls: options.openAiMaxToolCalls } }
        : undefined
    ),
    // Merged one namespace deep for the same reason, and here the collision is
    // certain rather than possible: every reasoning Anthropic model already
    // has `thinking` and `effort` under `anthropic`, and a shallow spread
    // would replace them with `cacheControl` alone -- a request that stops
    // reasoning and says nothing about it.
    options?.promptCachePath
      ? anthropicPromptCacheOptions(model, options.promptCachePath)
      : undefined
  );
  return {
    // The native Cohere SDK maps universal reasoning to its thinking setting.
    ...(model.provider === "cohere" && model.reasoning !== undefined
      ? { reasoning: model.reasoning }
      : {}),
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
