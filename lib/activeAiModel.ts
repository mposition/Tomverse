import "server-only";

import { anthropic } from "@ai-sdk/anthropic";
import { google } from "@ai-sdk/google";
import { createOpenAI, openai } from "@ai-sdk/openai";
import type { AiModel } from "@/lib/models";
import { deepseekUsageFetch } from "@/lib/deepseekUsageAdapter";
import { perplexityUsageFetch } from "@/lib/perplexityUsageCapture";

const groq = createOpenAI({
  baseURL: "https://api.groq.com/openai/v1",
  apiKey: process.env.GROQ_API_KEY,
});

const deepseek = createOpenAI({
  baseURL: "https://api.deepseek.com",
  apiKey: process.env.DEEPSEEK_API_KEY,
  fetch: deepseekUsageFetch,
});

const mistral = createOpenAI({
  baseURL: "https://api.mistral.ai/v1",
  apiKey: process.env.MISTRAL_API_KEY,
});

const xai = createOpenAI({
  baseURL: "https://api.x.ai/v1",
  apiKey: process.env.XAI_API_KEY,
});

const moonshot = createOpenAI({
  baseURL: "https://api.moonshot.ai/v1",
  apiKey: process.env.MOONSHOT_API_KEY,
});

const qwen = createOpenAI({
  baseURL: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
  apiKey: process.env.DASHSCOPE_API_KEY,
});

const zhipu = createOpenAI({
  baseURL: process.env.ZHIPU_BASE_URL || "https://api.z.ai/api/paas/v4",
  apiKey: process.env.ZHIPU_API_KEY,
});

const perplexity = createOpenAI({
  baseURL: "https://api.perplexity.ai",
  apiKey: process.env.PERPLEXITY_API_KEY,
  fetch: perplexityUsageFetch,
});

export const getActiveAiModel = (model: AiModel) => {
  switch (model.provider) {
    case "openai":
      return openai(model.apiModel);
    case "anthropic":
      return anthropic(model.apiModel);
    case "google":
      return google(model.apiModel);
    case "groq":
      return groq.chat(model.apiModel);
    case "deepseek":
      return deepseek.chat(model.apiModel);
    case "mistral":
      return mistral.chat(model.apiModel);
    case "xai":
      return xai.chat(model.apiModel);
    case "moonshot":
      return moonshot.chat(model.apiModel);
    case "qwen":
      return qwen.chat(model.apiModel);
    case "perplexity":
      return perplexity.chat(model.apiModel);
    case "zhipu":
      return zhipu.chat(model.apiModel);
  }
};
