import type { AiModel } from "@/lib/models";

export type ModelPickerLanguage = "en" | "ko" | "zh" | "fr" | "de" | "es" | "pt";
export type ModelPickerCapability = "all" | "recommended" | "fast" | "reasoning" | "search";
export type ModelPickerUsageBand = "all" | "light" | "medium" | "heavy" | "intensive";
export type ModelPickerFeature = "image" | "reasoning" | "search" | "code";

export const RECOMMENDED_MODEL_IDS = [
  "gpt-5-4-mini",
  "claude-sonnet-5",
  "deepseek-r1",
] as const;

const koreanDescriptions: Record<string, string> = {
  "gpt-5-5": "복잡한 분석과 중요한 의사결정",
  "gpt-5-5-thinking": "단계적인 사고가 필요한 어려운 문제",
  "gpt-5-4-mini": "빠른 일상 질문과 간단한 문서 작업",
  "claude-fable-5": "완성도 높은 글쓰기, 기획안과 긴 문서 분석",
  "claude-opus-4-8": "까다롭고 중요한 작업의 섬세한 추론",
  "claude-sonnet-5": "글쓰기, 구조화된 분석과 상세 문서 작업",
  "claude-haiku-4-5": "빠른 요약, 초안 작성과 가벼운 분석",
  "gemini-3-5-flash": "빠른 응답과 이미지·파일 분석",
  "gemini-3-1-pro": "상세한 멀티모달 분석과 복잡한 문서",
  "gemini-2-5-pro": "이전 세대 멀티모달 분석",
  "gemini-2-5-flash": "저비용 일상 작업과 빠른 파일 질문",
  "llama-3-1": "매우 빠르고 가벼운 텍스트 질문",
  "llama-4-scout": "빠른 이미지 질문과 긴 문맥 탐색",
  "llama-3-3": "오픈 모델 기반의 범용 텍스트 분석",
  "grok-4": "최신 이슈 대화와 폭넓은 고급 분석",
  "grok-4-5": "복잡한 기술·분석 작업의 깊은 추론",
  "grok-3": "직접적인 대화 스타일의 범용 분석",
  "grok-3-mini": "빠르고 간결한 일상 답변",
  "deepseek-v4-flash": "빠른 코딩 지원과 기술 질문",
  "deepseek-v4-pro": "비용 효율적인 기술 분석과 코딩",
  "deepseek-r1": "수학, 코드와 명시적 추론이 필요한 문제",
  "mistral-small-4": "효율적인 다국어 글쓰기와 일상 작업",
  "mistral-large-3": "고품질 다국어 분석과 긴 글 작업",
  "mistral-medium-3-1": "균형 잡힌 다국어 초안 작성과 분석",
  codestral: "코드 생성, 자동 완성과 저장소 질문",
  "kimi-k2.7-code": "코딩 작업과 긴 기술 문맥",
  "qwen3.7-max": "고난도 다국어 추론과 복잡한 지시",
  "qwen3.7-plus": "균형 잡힌 다국어 분석과 업무 글쓰기",
  "qwen3.6-flash": "빠른 다국어 질문과 번역",
  "glm-5.2": "범용 다국어 대화와 간결한 작업 지원",
  "perplexity/sonar": "출처가 포함된 빠른 웹 검색",
  "perplexity/sonar-pro": "더 폭넓은 출처를 활용한 상세 웹 조사",
  "perplexity/sonar-reasoning-pro": "추론이 필요한 출처 기반 조사",
  "perplexity/sonar-deep-research": "다수의 웹 출처를 활용한 장시간 조사",
};

export const modelPickerCopy: Record<
  ModelPickerLanguage,
  {
    recommendedModels: string;
    showAllModels: string;
    recommended: string;
    fast: string;
    deepReasoning: string;
    webSearch: string;
    allCapabilities: string;
    usageAll: string;
    light: string;
    medium: string;
    heavy: string;
    intensive: string;
    baseEstimate: string;
    estimatedUsage: string;
    multiplierApplied: string;
    done: string;
  }
> = {
  en: { recommendedModels: "Recommended models", showAllModels: "Show all models", recommended: "Recommended", fast: "Fast answers", deepReasoning: "Deep reasoning", webSearch: "Web search", allCapabilities: "All purposes", usageAll: "All usage", light: "Light · 1", medium: "Medium · 4", heavy: "Heavy · 8", intensive: "Intensive · 12+", baseEstimate: "base estimate", estimatedUsage: "Estimated", multiplierApplied: "long input or files included", done: "Done" },
  ko: { recommendedModels: "추천 모델", showAllModels: "전체 모델 보기", recommended: "나에게 추천", fast: "빠른 답변", deepReasoning: "깊은 추론", webSearch: "웹 검색", allCapabilities: "모든 용도", usageAll: "모든 사용량", light: "Light · 1", medium: "Medium · 4", heavy: "Heavy · 8", intensive: "Intensive · 12+", baseEstimate: "기본 예상", estimatedUsage: "예상", multiplierApplied: "긴 대화·파일 입력 반영", done: "선택 완료" },
  zh: { recommendedModels: "推荐模型", showAllModels: "查看全部模型", recommended: "推荐", fast: "快速回答", deepReasoning: "深度推理", webSearch: "网页搜索", allCapabilities: "全部用途", usageAll: "全部用量", light: "轻量 · 1", medium: "中等 · 4", heavy: "高 · 8", intensive: "密集 · 12+", baseEstimate: "基础预估", estimatedUsage: "预计", multiplierApplied: "已计入长对话或文件", done: "完成" },
  fr: { recommendedModels: "Modèles recommandés", showAllModels: "Voir tous les modèles", recommended: "Recommandés", fast: "Réponses rapides", deepReasoning: "Raisonnement approfondi", webSearch: "Recherche web", allCapabilities: "Tous les usages", usageAll: "Tous les usages crédit", light: "Léger · 1", medium: "Moyen · 4", heavy: "Élevé · 8", intensive: "Intensif · 12+", baseEstimate: "estimation de base", estimatedUsage: "Estimation", multiplierApplied: "conversation longue ou fichiers inclus", done: "Terminé" },
  de: { recommendedModels: "Empfohlene Modelle", showAllModels: "Alle Modelle anzeigen", recommended: "Empfohlen", fast: "Schnelle Antworten", deepReasoning: "Tiefes Denken", webSearch: "Websuche", allCapabilities: "Alle Zwecke", usageAll: "Alle Nutzungen", light: "Leicht · 1", medium: "Mittel · 4", heavy: "Hoch · 8", intensive: "Intensiv · 12+", baseEstimate: "Basisschätzung", estimatedUsage: "Geschätzt", multiplierApplied: "lange Eingabe oder Dateien enthalten", done: "Fertig" },
  es: { recommendedModels: "Modelos recomendados", showAllModels: "Ver todos los modelos", recommended: "Recomendados", fast: "Respuestas rápidas", deepReasoning: "Razonamiento profundo", webSearch: "Búsqueda web", allCapabilities: "Todos los usos", usageAll: "Todo el consumo", light: "Ligero · 1", medium: "Medio · 4", heavy: "Alto · 8", intensive: "Intensivo · 12+", baseEstimate: "estimación base", estimatedUsage: "Estimado", multiplierApplied: "entrada larga o archivos incluidos", done: "Listo" },
  pt: { recommendedModels: "Modelos recomendados", showAllModels: "Ver todos os modelos", recommended: "Recomendados", fast: "Respostas rápidas", deepReasoning: "Raciocínio profundo", webSearch: "Pesquisa web", allCapabilities: "Todos os usos", usageAll: "Todo o uso", light: "Leve · 1", medium: "Médio · 4", heavy: "Alto · 8", intensive: "Intensivo · 12+", baseEstimate: "estimativa base", estimatedUsage: "Estimado", multiplierApplied: "entrada longa ou arquivos incluídos", done: "Concluir" },
};

export const modelPickerFeatureLabels: Record<
  ModelPickerLanguage,
  Record<ModelPickerFeature, string>
> = {
  en: { image: "Image input", reasoning: "Deep reasoning", search: "Web search", code: "Code focused" },
  ko: { image: "이미지 입력", reasoning: "깊은 추론", search: "웹 검색", code: "코드 특화" },
  zh: { image: "图像输入", reasoning: "深度推理", search: "网页搜索", code: "代码专用" },
  fr: { image: "Entrée image", reasoning: "Raisonnement approfondi", search: "Recherche web", code: "Spécialisé code" },
  de: { image: "Bildeingabe", reasoning: "Tiefes Denken", search: "Websuche", code: "Code-Spezialist" },
  es: { image: "Entrada de imagen", reasoning: "Razonamiento profundo", search: "Búsqueda web", code: "Especializado en código" },
  pt: { image: "Entrada de imagem", reasoning: "Raciocínio profundo", search: "Pesquisa web", code: "Especializado em código" },
};

export const getModelPickerDescription = (
  model: Pick<AiModel, "id" | "bestFor">,
  language: ModelPickerLanguage
) => (language === "ko" ? koreanDescriptions[model.id] || model.bestFor : model.bestFor);

export const getModelPickerFeatures = (
  model: Pick<AiModel, "id" | "provider" | "reasoning" | "inputCapabilities">
): ModelPickerFeature[] => {
  const features: ModelPickerFeature[] = [];
  if (model.provider === "perplexity") features.push("search");
  if (model.reasoning && model.reasoning !== "none") features.push("reasoning");
  if (model.id.includes("code") || model.id === "codestral") features.push("code");
  if (model.inputCapabilities?.image) features.push("image");
  return features.slice(0, 2);
};

export const getModelPickerUsageBand = (credits: number): Exclude<ModelPickerUsageBand, "all"> => {
  if (credits <= 1) return "light";
  if (credits <= 4) return "medium";
  if (credits <= 8) return "heavy";
  return "intensive";
};

export const modelMatchesCapability = (
  model: AiModel,
  capability: ModelPickerCapability
) => {
  if (capability === "all") return true;
  if (capability === "recommended") {
    return (RECOMMENDED_MODEL_IDS as readonly string[]).includes(model.id);
  }
  if (capability === "reasoning") {
    return Boolean(model.reasoning && model.reasoning !== "none");
  }
  if (capability === "search") return model.provider === "perplexity";
  const name = `${model.id} ${model.name}`.toLowerCase();
  return ["mini", "flash", "haiku", "small", "lite", "llama-3-1"].some((term) =>
    name.includes(term)
  );
};
