import {
  AVAILABLE_MODELS,
  canUseModelWithPlan,
  getModel,
  getModelUsageProfile,
  type AiModel,
} from "./models.ts";

export const MODEL_FINDER_TASKS = [
  "documents",
  "writing",
  "coding",
  "research",
  "multilingual",
  "general",
] as const;

export const MODEL_FINDER_PRIORITIES = [
  "fast",
  "balanced",
  "deep",
  "sources",
] as const;

export const MODEL_FINDER_FILE_USAGE = [
  "documents",
  "images",
  "rarely",
] as const;

export type ModelFinderTask = (typeof MODEL_FINDER_TASKS)[number];
export type ModelFinderPriority = (typeof MODEL_FINDER_PRIORITIES)[number];
export type ModelFinderFileUsage = (typeof MODEL_FINDER_FILE_USAGE)[number];

export type ModelFinderAnswers = {
  tasks: ModelFinderTask[];
  priority: ModelFinderPriority;
  fileUsage: ModelFinderFileUsage;
};

export type ModelFinderRecommendation = {
  modelId: string;
  reasonKey: string;
  score: number;
};

const STANDARD_CANDIDATE_ORDER = [
  "gpt-5-4-mini",
  "gemini-2-5-flash",
  "claude-haiku-4-5",
  "deepseek-v4-flash",
  "mistral-small-4",
  "qwen3.6-flash",
] as const;

const TASK_SCORES: Record<ModelFinderTask, Partial<Record<string, number>>> = {
  documents: {
    "gemini-2-5-flash": 5,
    "gpt-5-4-mini": 4,
    "claude-haiku-4-5": 3,
  },
  writing: {
    "claude-haiku-4-5": 11,
    "gpt-5-4-mini": 3,
    "gemini-2-5-flash": 2,
  },
  coding: {
    "deepseek-v4-flash": 12,
    "gpt-5-4-mini": 3,
    "qwen3.6-flash": 2,
  },
  research: {
    "gpt-5-4-mini": 4,
    "gemini-2-5-flash": 4,
    "qwen3.6-flash": 2,
  },
  multilingual: {
    "mistral-small-4": 12,
    "qwen3.6-flash": 10,
    "gemini-2-5-flash": 3,
  },
  general: {
    "gpt-5-4-mini": 5,
    "gemini-2-5-flash": 5,
    "claude-haiku-4-5": 2,
  },
};

const PRIORITY_SCORES: Record<
  ModelFinderPriority,
  Partial<Record<string, number>>
> = {
  fast: {
    "gemini-2-5-flash": 5,
    "gpt-5-4-mini": 3,
    "deepseek-v4-flash": 2,
  },
  balanced: {
    "gpt-5-4-mini": 5,
    "gemini-2-5-flash": 4,
    "claude-haiku-4-5": 2,
  },
  deep: {
    "gpt-5-4-mini": 5,
    "claude-haiku-4-5": 4,
    "gemini-2-5-flash": 2,
  },
  sources: {
    "gpt-5-4-mini": 4,
    "gemini-2-5-flash": 4,
    "qwen3.6-flash": 2,
  },
};

const FILE_SCORES: Record<
  ModelFinderFileUsage,
  Partial<Record<string, number>>
> = {
  documents: {
    "gemini-2-5-flash": 6,
    "gpt-5-4-mini": 4,
    "claude-haiku-4-5": 3,
  },
  images: {
    "gemini-2-5-flash": 6,
    "gpt-5-4-mini": 5,
  },
  rarely: {
    "gpt-5-4-mini": 2,
    "deepseek-v4-flash": 1,
  },
};

const REASON_BY_MODEL: Record<string, string> = {
  "gpt-5-4-mini": "modelFinder.reasons.general",
  "gemini-2-5-flash": "modelFinder.reasons.filesFast",
  "claude-haiku-4-5": "modelFinder.reasons.writing",
  "deepseek-v4-flash": "modelFinder.reasons.coding",
  "mistral-small-4": "modelFinder.reasons.multilingual",
  "qwen3.6-flash": "modelFinder.reasons.multilingual",
};

const addScores = (
  scores: Map<string, number>,
  additions: Partial<Record<string, number>>
) => {
  for (const [modelId, score] of Object.entries(additions)) {
    scores.set(modelId, (scores.get(modelId) || 0) + (score || 0));
  }
};

export const isModelFinderDefault = (
  model: AiModel | undefined
): model is AiModel =>
  Boolean(
    model?.enabled &&
      canUseModelWithPlan("Guest", model) &&
      getModelUsageProfile(model).category === "Standard"
  );

export const isModelFinderDefaultId = (modelId: string) =>
  isModelFinderDefault(getModel(modelId));

export const getModelFinderRecommendations = (
  answers: ModelFinderAnswers
): ModelFinderRecommendation[] => {
  const scores = new Map<string, number>(
    STANDARD_CANDIDATE_ORDER.map((modelId, index) => [
      modelId,
      STANDARD_CANDIDATE_ORDER.length - index,
    ])
  );

  for (const task of answers.tasks) addScores(scores, TASK_SCORES[task]);
  addScores(scores, PRIORITY_SCORES[answers.priority]);
  addScores(scores, FILE_SCORES[answers.fileUsage]);

  return STANDARD_CANDIDATE_ORDER.filter((modelId) =>
    isModelFinderDefaultId(modelId)
  )
    .map((modelId) => ({
      modelId,
      reasonKey: REASON_BY_MODEL[modelId] || "modelFinder.reasons.general",
      score: scores.get(modelId) || 0,
    }))
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return (
        STANDARD_CANDIDATE_ORDER.indexOf(
          left.modelId as (typeof STANDARD_CANDIDATE_ORDER)[number]
        ) -
        STANDARD_CANDIDATE_ORDER.indexOf(
          right.modelId as (typeof STANDARD_CANDIDATE_ORDER)[number]
        )
      );
    })
    .slice(0, 3);
};

export type OptionalModelSuggestion = {
  modelId: string;
  reason: "deep_analysis" | "research";
};

export const getOptionalModelSuggestion = (
  answers: ModelFinderAnswers
): OptionalModelSuggestion | null => {
  if (
    answers.priority === "sources" ||
    answers.tasks.includes("research")
  ) {
    return { modelId: "perplexity/sonar", reason: "research" };
  }
  if (
    answers.priority === "deep" ||
    answers.tasks.includes("documents")
  ) {
    return { modelId: "claude-sonnet-5", reason: "deep_analysis" };
  }
  return null;
};

export type ModelFinderComboRole = "primary" | "specialist" | "advanced";

export type ModelFinderComboPick = {
  modelId: string;
  role: ModelFinderComboRole;
  reasonKey: string;
};

// "AI 조합 추천": unlike getModelFinderRecommendations (a ranked list the
// caller picks ONE winner from), this always returns a small combination of
// 2-3 complementary models meant to be selected together, reusing the same
// scoring tables so there's no second taxonomy to maintain.
export const getModelFinderCombination = (
  answers: { tasks: ModelFinderTask[]; priority: ModelFinderPriority }
): ModelFinderComboPick[] => {
  const fullAnswers: ModelFinderAnswers = { ...answers, fileUsage: "rarely" };
  const ranked = getModelFinderRecommendations(fullAnswers);
  if (!ranked.length) return [];

  const picks: ModelFinderComboPick[] = [
    {
      modelId: ranked[0].modelId,
      role: "primary",
      reasonKey: ranked[0].reasonKey,
    },
  ];
  const usedIds = new Set(picks.map((pick) => pick.modelId));

  for (const task of answers.tasks) {
    if (usedIds.size >= 2) break;
    const taskScores = Object.entries(TASK_SCORES[task] || {})
      .filter(([modelId]) => !usedIds.has(modelId) && isModelFinderDefaultId(modelId))
      .sort(([, left], [, right]) => (right || 0) - (left || 0));
    const bestModelId = taskScores[0]?.[0];
    if (bestModelId) {
      picks.push({
        modelId: bestModelId,
        role: "specialist",
        reasonKey: REASON_BY_MODEL[bestModelId] || "modelFinder.reasons.general",
      });
      usedIds.add(bestModelId);
    }
  }

  if (usedIds.size < 2) {
    const backfill = ranked.find((entry) => !usedIds.has(entry.modelId));
    if (backfill) {
      picks.push({
        modelId: backfill.modelId,
        role: "specialist",
        reasonKey: backfill.reasonKey,
      });
      usedIds.add(backfill.modelId);
    }
  }

  const optional = getOptionalModelSuggestion(fullAnswers);
  if (optional && !usedIds.has(optional.modelId) && picks.length < 3) {
    picks.push({
      modelId: optional.modelId,
      role: "advanced",
      reasonKey:
        optional.reason === "research"
          ? "modelFinder.optionalResearch"
          : "modelFinder.optionalDeep",
    });
  }

  return picks;
};

export const getModelFinderPromptKey = (answers: ModelFinderAnswers) => {
  if (answers.tasks.includes("documents")) return "modelFinder.prompts.documents";
  if (answers.tasks.includes("writing")) return "modelFinder.prompts.writing";
  if (answers.tasks.includes("coding")) return "modelFinder.prompts.coding";
  if (answers.tasks.includes("research")) return "modelFinder.prompts.research";
  if (answers.tasks.includes("multilingual")) return "modelFinder.prompts.multilingual";
  return "modelFinder.prompts.general";
};

export type ContextualModelSuggestion = OptionalModelSuggestion & {
  key: string;
};

const DOCUMENT_PATTERN =
  /\b(long document|contract|agreement|risk clause|due diligence|detailed document analysis)\b|계약서|긴\s*문서|위험\s*조항|정밀\s*분석|실사\s*검토/i;
const RESEARCH_PATTERN =
  /\b(source|sources|citation|citations|research|web search|latest evidence)\b|출처|근거|웹\s*검색|자료\s*조사|최신\s*정보/i;

export const getContextualModelSuggestion = ({
  text,
  attachments,
}: {
  text: string;
  attachments: Array<{ name?: string; mediaType?: string }>;
}): ContextualModelSuggestion | null => {
  const normalizedText = text.trim();
  const hasDocumentAttachment = attachments.some((attachment) => {
    const mediaType = attachment.mediaType || "";
    const name = attachment.name || "";
    return (
      mediaType === "application/pdf" ||
      mediaType.includes("officedocument") ||
      mediaType.includes("opendocument") ||
      /\.(pdf|docx|xlsx|pptx|odt|ods|odp)$/i.test(name)
    );
  });

  if (normalizedText.length >= 12 && RESEARCH_PATTERN.test(normalizedText)) {
    return {
      key: "research:perplexity/sonar",
      modelId: "perplexity/sonar",
      reason: "research",
    };
  }

  if (hasDocumentAttachment || DOCUMENT_PATTERN.test(normalizedText)) {
    return {
      key: "document:claude-sonnet-5",
      modelId: "claude-sonnet-5",
      reason: "deep_analysis",
    };
  }

  return null;
};

export const MODEL_FINDER_STANDARD_MODELS = AVAILABLE_MODELS.filter(
  isModelFinderDefault
);
