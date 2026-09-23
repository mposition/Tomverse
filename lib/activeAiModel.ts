import "server-only";

import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogle } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createMoonshotAI } from "@ai-sdk/moonshotai";
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
      return createOpenAI(configuration).chat(model.apiModel);
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
