import type { AiModel } from "@/lib/models";

/**
 * Which providers the main chat path may send a reasoning effort to.
 *
 * OpenAI only, and deliberately so. lib/activeAiModel.ts reaches OpenAI
 * through @ai-sdk/openai's Responses API, whose options schema types
 * `reasoningEffort`; every other provider in this app is an
 * OpenAI-*compatible* endpoint where support is per-model and unverified.
 * A parameter a provider rejects fails the request and is recorded as provider
 * health, which is how a healthy provider ends up published as an incident --
 * lib/providerProbe.ts carries two such incidents in its comments
 * (`max_output_tokens` below OpenAI's floor, an explicit `temperature`
 * moonshot refuses).
 *
 * Widening this set means verifying the target provider documents the field
 * for the exact model, not assuming OpenAI compatibility implies it.
 */
const REASONING_EFFORT_PROVIDERS = new Set<AiModel["provider"]>(["openai"]);

/**
 * The `providerOptions` a chat request needs so a reasoning model actually
 * reasons, or null when there is nothing to send.
 *
 * This exists because a catalogue `reasoning` value is otherwise inert. The
 * field drives the picker's badge, the reasoning filter and the usage class,
 * but until now nothing put it on the wire outside Perplexity's deep-research
 * submit. gpt-5-5-thinking is what that cost: it carries apiModel "gpt-5.5",
 * identical to gpt-5-5, so the two produced the same upstream request while
 * Thinking charged premium-reasoning (16 credits) against premium (8). A
 * variant that bills more has to *be* more.
 */
export const buildReasoningProviderOptions = (
  model: Pick<AiModel, "provider" | "reasoning">
): { openai: { reasoningEffort: string } } | null => {
  if (!REASONING_EFFORT_PROVIDERS.has(model.provider)) return null;
  if (!model.reasoning || model.reasoning === "none") return null;
  return { openai: { reasoningEffort: model.reasoning } };
};
