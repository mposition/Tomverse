/** Thin opt-in adapter. Imports provider clients only when an admitted call reaches this function. */
import { AVAILABLE_MODELS } from "./models";
import { benchmarkDigest, canonicalBenchmarkJson } from "./routerDevelopmentBenchmark";
import { COLLECTION_LIMITS, emptyCollectionObservation, collectionFail, validateCollectionOutcome, type CollectionObservation, type CollectionOutcome } from "./routerDevelopmentCollector";
import type { CollectionRequest } from "./routerDevelopmentCollectorJournal";

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const count = (value: unknown): number | null => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
const label = (value: unknown): string | null => typeof value === "string" && value.length > 0 && value.length <= 256 ? value : null;
const sum = (...values: (number | null)[]) => values.every((value) => value !== null) ? count(values.reduce<number>((total, value) => total + value!, 0)) : null;
const difference = (total: number | null, ...parts: (number | null)[]) => total !== null && parts.every((value) => value !== null) ? count(total - parts.reduce<number>((amount, value) => amount + value!, 0)) : null;
const hasItems = (value: unknown) => Array.isArray(value) && value.length > 0;
function finish(raw: string | null): CollectionObservation["finish"] {
  if (raw && ["stop", "end_turn", "stop_sequence", "STOP", "completed"].includes(raw)) return "stop";
  if (raw && ["length", "max_tokens", "max_output_tokens", "MAX_TOKENS"].includes(raw)) return "length";
  if (raw && ["content_filter", "SAFETY", "BLOCKLIST", "PROHIBITED_CONTENT", "RECITATION", "refusal"].includes(raw)) return "blocked";
  return "unknown";
}
/** Only provider-body fields count as observations. No SDK normalized usage/id fallback. */
export function observeCollectionBody(provider: string, body: unknown): CollectionObservation {
  const observation = emptyCollectionObservation();
  try {
    const root = record(body);
    if (!body || !Object.keys(root).length) return observation;
    const usage = record(root.usage);
    const choices = Array.isArray(root.choices) ? root.choices : [];
    const choice = record(choices[0]);
    const message = record(choice.message);
    if (provider === "openai") {
      observation.providerResponseId = label(root.id);
      observation.providerReportedModel = label(root.model);
      observation.inputTokens = count(usage.input_tokens);
      observation.outputTokens = count(usage.output_tokens);
      const input = record(usage.input_tokens_details);
      const output = record(usage.output_tokens_details);
      observation.cacheReadTokens = count(input.cached_tokens);
      observation.cacheWriteTokens = count(input.cache_write_tokens);
      observation.reasoningTokens = count(output.reasoning_tokens);
      observation.noCacheInputTokens = difference(observation.inputTokens, observation.cacheReadTokens, observation.cacheWriteTokens);
      observation.rawFinishReason = label(record(root.incomplete_details).reason);
      observation.finish = finish(observation.rawFinishReason ?? (root.status === "completed" ? "completed" : null));
      observation.unsupportedBilling = hasItems(root.output) && (root.output as unknown[]).some((part) => !["message", "reasoning"].includes(String(record(part).type)));
      if ([input.orchestration_input_tokens, input.orchestration_input_cached_tokens, output.orchestration_output_tokens].some((value) => value !== undefined && value !== null && value !== 0)) observation.unsupportedBilling = true;
    } else if (["deepseek", "xai", "mistral", "moonshot"].includes(provider)) {
      observation.providerResponseId = label(root.id);
      observation.providerReportedModel = label(root.model);
      observation.inputTokens = count(usage.prompt_tokens);
      observation.outputTokens = count(usage.completion_tokens);
      const input = record(usage.prompt_tokens_details);
      const output = record(usage.completion_tokens_details);
      // DeepSeek's product transport synthesizes input.cached_tokens. Use its retained original.
      observation.cacheReadTokens = provider === "deepseek" ? count(usage.prompt_cache_hit_tokens) : provider === "moonshot" && usage.cached_tokens !== undefined ? count(usage.cached_tokens) : count(input.cached_tokens);
      observation.cacheWriteTokens = count(input.cache_write_tokens);
      observation.reasoningTokens = count(output.reasoning_tokens);
      observation.noCacheInputTokens = difference(observation.inputTokens, observation.cacheReadTokens, observation.cacheWriteTokens);
      observation.rawFinishReason = label(choice.finish_reason);
      observation.finish = finish(observation.rawFinishReason);
      observation.unsupportedBilling = choices.length > 1 || hasItems(message.tool_calls) || message.function_call != null;
    } else if (provider === "anthropic" || provider === "minimax") {
      observation.providerResponseId = label(root.id);
      observation.providerReportedModel = label(root.model);
      observation.noCacheInputTokens = count(usage.input_tokens);
      observation.cacheReadTokens = count(usage.cache_read_input_tokens);
      observation.cacheWriteTokens = count(usage.cache_creation_input_tokens);
      observation.inputTokens = sum(observation.noCacheInputTokens, observation.cacheReadTokens, observation.cacheWriteTokens);
      observation.outputTokens = count(usage.output_tokens);
      observation.reasoningTokens = count(record(usage.output_tokens_details).thinking_tokens);
      observation.rawFinishReason = label(root.stop_reason);
      observation.finish = finish(observation.rawFinishReason);
      observation.unsupportedBilling = hasItems(usage.iterations) || (Array.isArray(root.content) && root.content.some((part) => !["text", "thinking", "redacted_thinking"].includes(String(record(part).type))));
    } else if (provider === "google") {
      const googleUsage = record(root.usageMetadata);
      const candidates = Array.isArray(root.candidates) ? root.candidates : [];
      const candidate = record(candidates[0]);
      observation.providerResponseId = label(root.responseId);
      observation.providerReportedModel = label(root.modelVersion);
      observation.inputTokens = count(googleUsage.promptTokenCount);
      observation.reasoningTokens = count(googleUsage.thoughtsTokenCount);
      // Missing thoughts are unknown, not zero; SDK-normalized output is not evidence.
      observation.outputTokens = sum(count(googleUsage.candidatesTokenCount), observation.reasoningTokens);
      observation.cacheReadTokens = count(googleUsage.cachedContentTokenCount);
      observation.rawFinishReason = label(candidate.finishReason) ?? label(record(root.promptFeedback).blockReason);
      observation.finish = finish(observation.rawFinishReason);
      observation.unsupportedBilling = candidates.length > 1 || googleUsage.toolUsePromptTokenCount != null && googleUsage.toolUsePromptTokenCount !== 0 || candidate.groundingMetadata != null || hasItems(record(candidate.content).parts) && (record(candidate.content).parts as unknown[]).some((part) => record(part).functionCall != null);
    } else return observation;
    observation.servedProcessingTier = label(root.service_tier ?? usage.service_tier ?? record(root.usageMetadata).serviceTier);
    if (observation.servedProcessingTier !== null && !["default", "standard", "auto"].includes(observation.servedProcessingTier.toLowerCase())) observation.unsupportedBilling = true;
    observation.source = "provider_body_allowlist";
    return observation;
  } catch {
    // Metadata extraction must not discard an answer or an already committed reservation.
    return emptyCollectionObservation();
  }
}
export function collectionReturnedOutcome(provider: string, body: unknown, text: unknown, latencyMs: number): CollectionOutcome {
  const observation = observeCollectionBody(provider, body);
  if (typeof text !== "string") return { status: "measurement_unsupported", answerText: null, answerBytes: null, answerDigest: null, textOmitted: false, completeResponse: false, failureCode: "answer_unavailable", latencyMs, observation };
  const bytes = Buffer.byteLength(text);
  const omitted = bytes > COLLECTION_LIMITS.answerStorageBytes;
  return validateCollectionOutcome({ status: omitted || observation.unsupportedBilling ? "measurement_unsupported" : "returned",
    answerText: omitted ? null : text, answerBytes: bytes, answerDigest: benchmarkDigest(text), textOmitted: omitted,
    completeResponse: true, failureCode: omitted ? "answer_storage_limit" : observation.unsupportedBilling ? "provider_billing_unsupported" : null, latencyMs, observation });
}
export type CollectionSdkDependencies = {
  generate: (options: Record<string, unknown>) => Promise<unknown>;
  getModel: (model: (typeof AVAILABLE_MODELS)[number]) => unknown;
  getSettings: (model: (typeof AVAILABLE_MODELS)[number]) => unknown;
  now?: () => number;
};
/** Test seam uses ai/test MockLanguageModelV4; production dependencies are never caller CLI input. */
export function createCollectionSdkAdapter(dependencies: CollectionSdkDependencies) {
  return async (request: CollectionRequest): Promise<CollectionOutcome> => {
    const model = AVAILABLE_MODELS.find((candidate) => candidate.id === request.modelId);
    if (!model) collectionFail("provider_model_unknown");
    const settings = dependencies.getSettings(model!);
    if (canonicalBenchmarkJson(settings) !== canonicalBenchmarkJson(request.settings)) collectionFail("provider_settings_drift");
    const now = dependencies.now ?? Date.now;
    const start = now();
    try {
      // SDK 7: responseBody is opt-in; maxRetries defaults to 2 unless explicitly disabled.
      // https://github.com/vercel/ai/blob/main/content/docs/08-migration-guides/23-migration-guide-7-0.mdx
      const result = record(await dependencies.generate({ model: dependencies.getModel(model!), ...request.settings,
        prompt: request.prompt, maxOutputTokens: request.maxOutputTokens, maxRetries: 0,
        abortSignal: request.signal, include: { responseBody: true } }));
      const step = record(result.finalStep);
      const observation = collectionReturnedOutcome(model!.provider, record(step.response).body, result.text, Math.max(0, Math.round(now() - start)));
      if (!Array.isArray(result.steps) || result.steps.length !== 1) return { ...observation, status: "measurement_unsupported", failureCode: "multiple_or_missing_steps" };
      return observation;
    } catch (error) {
      const elapsed = Math.max(0, Math.round(now() - start));
      let body: unknown;
      let statusCode: number | null = null;
      try {
        const value = record(error);
        statusCode = count(value.statusCode);
        if (typeof value.responseBody === "string" && Buffer.byteLength(value.responseBody) <= COLLECTION_LIMITS.eventBytes) {
          // Transient parsing only. No raw error/body/request/header is retained.
          try { body = JSON.parse(value.responseBody); } catch { /* Unknown metadata stays null. */ }
        } else if (value.responseBody && typeof value.responseBody === "object") body = value.responseBody;
      } catch { /* Errors may carry throwing getters. */ }
      const timedOut = request.signal.aborted;
      const observation = observeCollectionBody(model!.provider, body);
      return { status: observation.unsupportedBilling ? "measurement_unsupported" : timedOut ? "timeout" : statusCode !== null ? "failed" : "unknown", answerText: null, answerBytes: null,
        answerDigest: null, textOmitted: false, completeResponse: !timedOut && statusCode !== null,
        failureCode: observation.unsupportedBilling ? "provider_billing_unsupported" : timedOut ? "deadline_abort_billing_unknown" : statusCode !== null ? "provider_http_error" : "provider_outcome_unknown",
        latencyMs: elapsed, observation };
    }
  };
}
export async function collectFromProvider(request: CollectionRequest): Promise<CollectionOutcome> {
  const [{ generateText }, { getActiveAiModel }, { getModelGenerationSettings }] = await Promise.all([
    import("ai"), import("./activeAiModel"), import("./modelGenerationCompatibility"),
  ]);
  const adapter = createCollectionSdkAdapter({ generate: (options) => generateText(options as Parameters<typeof generateText>[0]), getModel: getActiveAiModel, getSettings: getModelGenerationSettings });
  return adapter(request);
}
