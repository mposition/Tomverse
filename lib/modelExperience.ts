import type { AiModel } from "@/lib/models";

export type ModelExperienceStatus = "available" | "limited" | "unavailable";

const providerTags: Partial<Record<AiModel["provider"], string[]>> = {
  openai: ["General", "Files"],
  anthropic: ["Writing", "Analysis"],
  google: ["Fast", "Files"],
  groq: ["Fast", "Open"],
  xai: ["Current"],
  deepseek: ["Cost-friendly"],
  mistral: ["EU", "Multilingual"],
  moonshot: ["Coding"],
  qwen: ["Multilingual"],
  perplexity: ["Search"],
};

export const getModelExperienceTags = (model: AiModel) => {
  const tags = new Set<string>(providerTags[model.provider] ?? []);

  if (model.reasoning && model.reasoning !== "none") tags.add("Reasoning");
  if (model.tier === "Free") tags.add("Free");
  if (model.name.toLowerCase().includes("code") || model.id.includes("codestral")) {
    tags.add("Coding");
  }
  if (model.name.toLowerCase().includes("small") || model.name.toLowerCase().includes("flash")) {
    tags.add("Fast");
  }
  if (model.provider === "perplexity") tags.add("Research");

  return Array.from(tags).slice(0, 4);
};

export const getModelExperienceStatus = (model: AiModel): ModelExperienceStatus => {
  if (!model.enabled) return "unavailable";
  if (model.status !== "enabled") return "limited";
  return "available";
};

export const getModelBestFor = (model: AiModel) => {
  if (model.provider === "perplexity") return "Best for sourced research and web-aware answers.";
  if (model.provider === "mistral") return "Best for multilingual EU-friendly workflows.";
  if (model.provider === "anthropic") return "Best for writing, analysis, and long-form reasoning.";
  if (model.provider === "google") return "Best for fast everyday work and file-friendly tasks.";
  if (model.provider === "groq") return "Best for fast open-model responses.";
  if (model.provider === "deepseek") return "Best for cost-conscious reasoning and technical tasks.";
  if (model.provider === "qwen") return "Best for multilingual and broad general tasks.";
  if (model.provider === "moonshot") return "Best for code-heavy work.";
  if (model.provider === "xai") return "Best for direct answers and current model comparisons.";
  return "Best for general AI work.";
};
