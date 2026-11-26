export const DEEP_RESEARCH_MODEL_ID = "perplexity/sonar-deep-research";
export const DEEP_RESEARCH_DEFAULT_DEPTH = "standard";
export const DEEP_RESEARCH_DEPTHS = ["quick", DEEP_RESEARCH_DEFAULT_DEPTH, "deep"] as const;

export const estimateDeepResearchInputTokens = (text: string) =>
  Math.max(1, Math.ceil(new TextEncoder().encode(text).length / 4));
