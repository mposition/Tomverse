import type { AiModel } from "@/lib/models";

export type ModelExperienceStatus = "available" | "limited" | "unavailable";

export type ModelExperienceTag =
  | "general"
  | "files"
  | "writing"
  | "analysis"
  | "fast"
  | "open"
  | "current"
  | "costFriendly"
  | "eu"
  | "multilingual"
  | "coding"
  | "search"
  | "reasoning"
  | "free"
  | "research";

const providerTags: Partial<Record<AiModel["provider"], ModelExperienceTag[]>> = {
  openai: ["general", "files"],
  anthropic: ["writing", "analysis"],
  google: ["fast", "files"],
  groq: ["fast", "open"],
  xai: ["current"],
  deepseek: ["costFriendly"],
  mistral: ["eu", "multilingual"],
  moonshot: ["coding"],
  qwen: ["multilingual"],
  perplexity: ["search"],
};

export const getModelExperienceTags = (model: AiModel) => {
  const tags = new Set<ModelExperienceTag>(providerTags[model.provider] ?? []);

  if (model.reasoning && model.reasoning !== "none") tags.add("reasoning");
  if (model.tier === "Free") tags.add("free");
  if (model.name.toLowerCase().includes("code") || model.id.includes("codestral")) {
    tags.add("coding");
  }
  if (model.name.toLowerCase().includes("small") || model.name.toLowerCase().includes("flash")) {
    tags.add("fast");
  }
  if (model.provider === "perplexity") tags.add("research");

  return Array.from(tags).slice(0, 4);
};

export const getModelExperienceStatus = (model: AiModel): ModelExperienceStatus => {
  if (!model.enabled) return "unavailable";
  if (model.status !== "enabled") return "limited";
  return "available";
};

export const getModelBestForKey = (model: AiModel) => {
  if (model.provider === "perplexity") return "perplexity";
  if (model.provider === "mistral") return "mistral";
  if (model.provider === "anthropic") return "anthropic";
  if (model.provider === "google") return "google";
  if (model.provider === "groq") return "groq";
  if (model.provider === "deepseek") return "deepseek";
  if (model.provider === "qwen") return "qwen";
  if (model.provider === "moonshot") return "moonshot";
  if (model.provider === "xai") return "xai";
  return "default";
};

export const getModelBestFor = (model: AiModel) => `modelBestFor.${getModelBestForKey(model)}`;
