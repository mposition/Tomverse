import "server-only";

import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogle } from "@ai-sdk/google";
import { createMistral } from "@ai-sdk/mistral";
import { createOpenAI } from "@ai-sdk/openai";
import { createMoonshotAI } from "@ai-sdk/moonshotai";
import { defaultSettingsMiddleware, wrapLanguageModel, type StepResult, type ToolSet } from "ai";
import type { AiModel } from "@/lib/models";
import {
  decideOpenRouterDispatch,
  DeploymentHostRefusal,
  openRouterPinnedFetch,
  OpenRouterDispatchError,
  PROVIDER_API_CONFIGURATION,
  readOpenRouterRecipientAllowlist,
  resolveProviderApiKey,
  type OpenRouterRequest,
} from "@/lib/modelRegistryShared";
import { deepseekUsageFetch } from "@/lib/deepseekUsageAdapter";
import { perplexityUsageFetch } from "@/lib/perplexityUsageCapture";

const runtimeConfiguration = (model: AiModel) => {
  const defaults = PROVIDER_API_CONFIGURATION[model.provider];
  return {
    // These values deliberately never come from the model registry. Allowing a
    // DB-controlled URL or environment-variable name would turn a compromised
    // operator account into arbitrary server-secret exfiltration.
    baseURL: defaults.baseUrl,
    // Resolved through the shared alias list rather than the canonical name
    // alone: a provider whose key has more than one accepted spelling was
    // otherwise reported as configured by one part of the product and called
    // without a key by this one.
    apiKey: resolveProviderApiKey(model.provider),
  };
};

function searchReturnedSources(output: unknown): boolean {
  if (!output || typeof output !== "object" || !("status" in output)) return false;
  if (output.status === "batch") {
    return "searches" in output && Array.isArray(output.searches) && output.searches.length > 0 &&
      output.searches.every(searchReturnedSources);
  }
  return output.status === "ok" && "results" in output && Array.isArray(output.results) &&
    output.results.length > 0 && output.results.every(source => typeof source?.url === "string" && source.url.length > 0);
}

// Experiment allowance for checking supplied sources before answering or requesting another search.
export const QWEN_GROUNDED_THINKING_BUDGET = 128;

/** DashScope accepts enable_thinking and thinking_budget at the top level of Chat Completions. */
export function qwenLookupStep(model: AiModel, boundedThinking = false) {
  if (model.provider !== "qwen" || model.apiModel !== "qwen3.8-flash" ||
      (model.reasoning && (boundedThinking || model.reasoning !== "none"))) return undefined;
  const thinking = boundedThinking
    ? { enable_thinking: true, thinking_budget: QWEN_GROUNDED_THINKING_BUDGET }
    : { enable_thinking: false };
  const lookup = createOpenAI({ ...runtimeConfiguration(model), fetch: (url, init) => {
    // The SDK serializes the body; leave an unfamiliar request untouched.
    if (typeof init?.body !== "string") return fetch(url, init);
    let body;
    try { body = JSON.parse(init.body); } catch { return fetch(url, init); }
    if (!body || typeof body !== "object" || Array.isArray(body)) return fetch(url, init);
    return fetch(url, { ...init, body: JSON.stringify({ ...body, ...thinking }) });
  } }).chat(model.apiModel);
  return ({ stepNumber, steps }: { stepNumber: number; steps?: Pick<StepResult<ToolSet>, "toolCalls" | "toolResults">[] }) => {
    if (stepNumber === 0) return { model: lookup };
    if (!boundedThinking) return;
    const last = steps?.at(-1);
    if (!last?.toolCalls.length || last.toolCalls.length !== last.toolResults.length) return;
    const onlyCompletedSearches = last.toolCalls.every(call => call.toolName === "web_search" && !call.providerExecuted &&
      last.toolResults.some(result => result.toolName === call.toolName && result.toolCallId === call.toolCallId &&
        !result.providerExecuted && !result.preliminary && searchReturnedSources(result.output)));
    if (onlyCompletedSearches) return { model: lookup };
  };
}

export const getActiveAiModel = (
  model: AiModel,
  openRouterRequest?: OpenRouterRequest
) => {
  const configuration = runtimeConfiguration(model);
  switch (model.provider) {
    case "openai":
      return createOpenAI(configuration)(model.apiModel);
    case "anthropic":
      return createAnthropic(configuration)(model.apiModel);
    case "google":
      return createGoogle(configuration)(model.apiModel);
    case "groq":
      return createOpenAI(configuration).chat(model.apiModel);
    case "deepseek":
      return createOpenAI({ ...configuration, fetch: deepseekUsageFetch }).chat(
        model.apiModel
      );
    case "mistral":
      // Mistral returns thinking/text chunks in message.content. The OpenAI
      // adapter accepts only a string there and rejects successful responses.
      return wrapLanguageModel({
        model: createMistral(configuration)(model.apiModel),
        // Preserve the OpenAI adapter's strict structured-output default.
        middleware: defaultSettingsMiddleware({
          settings: { providerOptions: { mistral: { strictJsonSchema: true } } },
        }),
      });
    case "xai":
      return createOpenAI(configuration).chat(model.apiModel);
    case "moonshot":
      // The dedicated provider preserves reasoning_content as an AI SDK
      // reasoning part. The generic OpenAI adapter silently discarded it.
      return createMoonshotAI(configuration)(model.apiModel);
    case "minimax":
      return createAnthropic(configuration)(model.apiModel);
    case "qwen":
      return createOpenAI(configuration).chat(model.apiModel);
    case "perplexity":
      return createOpenAI({ ...configuration, fetch: perplexityUsageFetch }).chat(
        model.apiModel
      );
    case "zhipu":
      return createOpenAI(configuration).chat(model.apiModel);
    case "deepinfra":
    case "together":
    case "sail":
      // Inference hosts (ADR v2.1 provider pool). A catalogue model must not
      // call them: the price on the catalogue row is the direct connection's
      // price, and the destination row for these hosts is unproven. A hosted
      // copy is a deployment, and this function is the catalogue adapter.
      throw new DeploymentHostRefusal();
    case "openrouter": {
      // Emergency aggregator. The pin is applied inside the fetch. The
      // allowlist is the operator environment variable, not the request.
      // A missing request throws before any client is built. The gate lives
      // in lib/modelRegistryShared.ts, which this file already imports.
      if (!openRouterRequest) throw new OpenRouterDispatchError("OPENROUTER_ADMISSION_REQUIRED");
      const allowlist = readOpenRouterRecipientAllowlist();
      if (!allowlist.ok) throw new OpenRouterDispatchError(allowlist.code);
      const decision = decideOpenRouterDispatch(openRouterRequest, allowlist.allowlist);
      if (!decision.ok) throw new OpenRouterDispatchError(decision.code);
      return createOpenAI({
        ...configuration,
        fetch: openRouterPinnedFetch(decision.pin, fetch),
      }).chat(model.apiModel);
    }
  }
};
