import "server-only";

import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogle } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import type { AiModel } from "@/lib/models";
import { PROVIDER_API_CONFIGURATION } from "@/lib/modelRegistryShared";
import { deepseekUsageFetch } from "@/lib/deepseekUsageAdapter";
import { perplexityUsageFetch } from "@/lib/perplexityUsageCapture";

const runtimeConfiguration = (model: AiModel) => {
  const defaults = PROVIDER_API_CONFIGURATION[model.provider];
  return {
    // These values deliberately never come from the model registry. Allowing a
    // DB-controlled URL or environment-variable name would turn a compromised
    // operator account into arbitrary server-secret exfiltration.
    baseURL: defaults.baseUrl,
    apiKey: process.env[defaults.apiKeyEnvName],
  };
};

export const getActiveAiModel = (model: AiModel) => {
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
      return createOpenAI(configuration).chat(model.apiModel);
    case "qwen":
      return createOpenAI(configuration).chat(model.apiModel);
    case "perplexity":
      return createOpenAI({ ...configuration, fetch: perplexityUsageFetch }).chat(
        model.apiModel
      );
    case "zhipu":
      return createOpenAI(configuration).chat(model.apiModel);
  }
};
