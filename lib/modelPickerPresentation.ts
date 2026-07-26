import type { AiModel } from "@/lib/models";
import { getWebSearchCapability } from "@/lib/webSearchCapability";

export type ModelPickerLanguage = "en" | "ko" | "zh" | "fr" | "de" | "es" | "pt";
export type ModelPickerCapability = "all" | "favorites" | "recommended" | "fast" | "reasoning" | "search";
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
    personalizedRecommendations: string;
    tomverseRecommendations: string;
    allModels: string;
    searchPlaceholder: string;
    providerAll: string;
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
    filters: string;
    imageInputOnly: string;
    availableOnPlan: string;
    selectedModelsLabel: string;
    baseEstimate: string;
    estimatedUsage: string;
    multiplierApplied: string;
    done: string;
    estimatedUsageTitle: string;
    total: string;
  }
> = {
  en: { recommendedModels: "Recommended models", personalizedRecommendations: "Recommended for you", tomverseRecommendations: "Tomverse recommends", allModels: "All models", searchPlaceholder: "Search model names or tasks", providerAll: "Provider: All", recommended: "Recommended", fast: "Fast answers", deepReasoning: "Deep reasoning", webSearch: "Web search", allCapabilities: "All purposes", usageAll: "Usage: All", light: "Light · 1", medium: "Medium · 4", heavy: "Heavy · 8", intensive: "Intensive · 12+", filters: "More filters", imageInputOnly: "Image input", availableOnPlan: "Available on my plan", selectedModelsLabel: "Selected", baseEstimate: "base estimate", estimatedUsage: "Estimated", multiplierApplied: "long input or files included", done: "Done", estimatedUsageTitle: "Estimated usage", total: "Total" },
  ko: { recommendedModels: "추천 모델", personalizedRecommendations: "나에게 추천", tomverseRecommendations: "Tomverse 추천", allModels: "전체 모델", searchPlaceholder: "모델 이름 또는 작업 검색", providerAll: "Provider: 전체", recommended: "추천", fast: "빠른 답변", deepReasoning: "깊은 추론", webSearch: "웹 검색", allCapabilities: "모든 용도", usageAll: "사용량: 전체", light: "Light · 1", medium: "Medium · 4", heavy: "Heavy · 8", intensive: "Intensive · 12+", filters: "추가 필터", imageInputOnly: "이미지 입력", availableOnPlan: "내 플랜에서 사용 가능", selectedModelsLabel: "선택한 모델", baseEstimate: "기본 예상", estimatedUsage: "예상", multiplierApplied: "긴 대화·파일 입력 반영", done: "선택 완료", estimatedUsageTitle: "예상 사용량", total: "합계" },
  zh: { recommendedModels: "推荐模型", personalizedRecommendations: "为你推荐", tomverseRecommendations: "Tomverse 推荐", allModels: "全部模型", searchPlaceholder: "搜索模型名称或任务", providerAll: "提供商：全部", recommended: "推荐", fast: "快速回答", deepReasoning: "深度推理", webSearch: "网页搜索", allCapabilities: "全部用途", usageAll: "用量：全部", light: "轻量 · 1", medium: "中等 · 4", heavy: "高 · 8", intensive: "密集 · 12+", filters: "更多筛选", imageInputOnly: "图像输入", availableOnPlan: "我的套餐可用", selectedModelsLabel: "已选模型", baseEstimate: "基础预估", estimatedUsage: "预计", multiplierApplied: "已计入长对话或文件", done: "完成", estimatedUsageTitle: "预计用量", total: "合计" },
  fr: { recommendedModels: "Modèles recommandés", personalizedRecommendations: "Recommandés pour vous", tomverseRecommendations: "Recommandés par Tomverse", allModels: "Tous les modèles", searchPlaceholder: "Rechercher un modèle ou une tâche", providerAll: "Fournisseur : tous", recommended: "Recommandés", fast: "Réponses rapides", deepReasoning: "Raisonnement approfondi", webSearch: "Recherche web", allCapabilities: "Tous les usages", usageAll: "Usage : tous", light: "Léger · 1", medium: "Moyen · 4", heavy: "Élevé · 8", intensive: "Intensif · 12+", filters: "Plus de filtres", imageInputOnly: "Entrée image", availableOnPlan: "Disponible avec mon forfait", selectedModelsLabel: "Sélectionnés", baseEstimate: "estimation de base", estimatedUsage: "Estimation", multiplierApplied: "conversation longue ou fichiers inclus", done: "Terminé", estimatedUsageTitle: "Utilisation estimée", total: "Total" },
  de: { recommendedModels: "Empfohlene Modelle", personalizedRecommendations: "Für dich empfohlen", tomverseRecommendations: "Tomverse empfiehlt", allModels: "Alle Modelle", searchPlaceholder: "Modellnamen oder Aufgaben suchen", providerAll: "Anbieter: Alle", recommended: "Empfohlen", fast: "Schnelle Antworten", deepReasoning: "Tiefes Denken", webSearch: "Websuche", allCapabilities: "Alle Zwecke", usageAll: "Nutzung: Alle", light: "Leicht · 1", medium: "Mittel · 4", heavy: "Hoch · 8", intensive: "Intensiv · 12+", filters: "Weitere Filter", imageInputOnly: "Bildeingabe", availableOnPlan: "In meinem Tarif verfügbar", selectedModelsLabel: "Ausgewählt", baseEstimate: "Basisschätzung", estimatedUsage: "Geschätzt", multiplierApplied: "lange Eingabe oder Dateien enthalten", done: "Fertig", estimatedUsageTitle: "Geschätzte Nutzung", total: "Gesamt" },
  es: { recommendedModels: "Modelos recomendados", personalizedRecommendations: "Recomendados para ti", tomverseRecommendations: "Tomverse recomienda", allModels: "Todos los modelos", searchPlaceholder: "Buscar modelos o tareas", providerAll: "Proveedor: todos", recommended: "Recomendados", fast: "Respuestas rápidas", deepReasoning: "Razonamiento profundo", webSearch: "Búsqueda web", allCapabilities: "Todos los usos", usageAll: "Uso: todo", light: "Ligero · 1", medium: "Medio · 4", heavy: "Alto · 8", intensive: "Intensivo · 12+", filters: "Más filtros", imageInputOnly: "Entrada de imagen", availableOnPlan: "Disponible en mi plan", selectedModelsLabel: "Seleccionados", baseEstimate: "estimación base", estimatedUsage: "Estimado", multiplierApplied: "entrada larga o archivos incluidos", done: "Listo", estimatedUsageTitle: "Uso estimado", total: "Total" },
  pt: { recommendedModels: "Modelos recomendados", personalizedRecommendations: "Recomendados para você", tomverseRecommendations: "Tomverse recomenda", allModels: "Todos os modelos", searchPlaceholder: "Pesquisar modelos ou tarefas", providerAll: "Fornecedor: todos", recommended: "Recomendados", fast: "Respostas rápidas", deepReasoning: "Raciocínio profundo", webSearch: "Pesquisa web", allCapabilities: "Todos os usos", usageAll: "Uso: todo", light: "Leve · 1", medium: "Médio · 4", heavy: "Alto · 8", intensive: "Intensivo · 12+", filters: "Mais filtros", imageInputOnly: "Entrada de imagem", availableOnPlan: "Disponível no meu plano", selectedModelsLabel: "Selecionados", baseEstimate: "estimativa base", estimatedUsage: "Estimado", multiplierApplied: "entrada longa ou arquivos incluídos", done: "Concluir", estimatedUsageTitle: "Uso estimado", total: "Total" },
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

/**
 * Copy for the two-step picker (recommended screen -> all models). Kept as its
 * own record rather than folded into modelPickerCopy so the step-2 vocabulary
 * can grow without rewriting the seven single-line locale entries above.
 */
export const modelPickerStepCopy: Record<
  ModelPickerLanguage,
  {
    recommendedTitle: string;
    recommendedSubtitle: string;
    recommendedEmpty: string;
    openAllModels: string;
    openAllModelsHint: string;
    allModelsTitle: string;
    backToRecommended: string;
    filterSheetTitle: string;
    openFilters: string;
    resetAllFilters: string;
    resultCount: string;
    taskAll: string;
    searchResultsTitle: string;
    clearSearch: string;
    signInToUse: string;
    upgradeToUse: string;
    maxReached: string;
    activeFilters: string;
    sortLabel: string;
    sortRecommended: string;
    sortCredits: string;
    sortName: string;
  }
> = {
  en: {
    recommendedTitle: "Recommended for this kind of work",
    recommendedSubtitle: "Pick one to start. You can change models any time — it costs nothing.",
    recommendedEmpty: "No recommendations are available right now. Open All models to choose one yourself.",
    openAllModels: "All models",
    openAllModelsHint: "Browse the full catalogue with search and filters",
    allModelsTitle: "All models",
    backToRecommended: "Back to recommendations",
    filterSheetTitle: "Filters",
    openFilters: "Filters",
    resetAllFilters: "Reset all",
    resultCount: "{count} models",
    taskAll: "Task: All",
    searchResultsTitle: "Search results",
    clearSearch: "Clear search",
    signInToUse: "Sign in to use this model",
    upgradeToUse: "Upgrade your plan to use this model",
    maxReached: "You can compare up to {max} models. Remove one to add another.",
    activeFilters: "Filters {count}",
    sortLabel: "Sort",
    sortRecommended: "Suggested order",
    sortCredits: "Lowest credit cost first",
    sortName: "Name (A–Z)",
  },
  ko: {
    recommendedTitle: "이런 작업에 맞는 추천",
    recommendedSubtitle: "하나만 골라 시작하세요. 모델 변경은 언제든 가능하고 크레딧이 들지 않습니다.",
    recommendedEmpty: "지금 사용할 수 있는 추천 모델이 없습니다. 모든 모델에서 직접 선택해 주세요.",
    openAllModels: "모든 모델",
    openAllModelsHint: "검색과 필터로 전체 목록 살펴보기",
    allModelsTitle: "모든 모델",
    backToRecommended: "추천으로 돌아가기",
    filterSheetTitle: "필터",
    openFilters: "필터",
    resetAllFilters: "모두 초기화",
    resultCount: "모델 {count}개",
    taskAll: "작업: 전체",
    searchResultsTitle: "검색 결과",
    clearSearch: "검색 지우기",
    signInToUse: "로그인하면 사용할 수 있어요",
    upgradeToUse: "플랜을 업그레이드하면 사용할 수 있어요",
    maxReached: "최대 {max}개까지 비교할 수 있어요. 하나를 빼면 다른 모델을 추가할 수 있습니다.",
    activeFilters: "필터 {count}",
    sortLabel: "정렬",
    sortRecommended: "추천 순서",
    sortCredits: "크레딧 낮은 순",
    sortName: "이름순 (가나다)",
  },
  zh: {
    recommendedTitle: "适合这类工作的推荐",
    recommendedSubtitle: "先选一个开始。随时可以更换模型，不消耗额度。",
    recommendedEmpty: "目前没有可用的推荐模型。请打开全部模型自行选择。",
    openAllModels: "全部模型",
    openAllModelsHint: "使用搜索和筛选浏览完整目录",
    allModelsTitle: "全部模型",
    backToRecommended: "返回推荐",
    filterSheetTitle: "筛选",
    openFilters: "筛选",
    resetAllFilters: "全部重置",
    resultCount: "{count} 个模型",
    taskAll: "任务：全部",
    searchResultsTitle: "搜索结果",
    clearSearch: "清除搜索",
    signInToUse: "登录后即可使用",
    upgradeToUse: "升级套餐后即可使用",
    maxReached: "最多可对比 {max} 个模型。移除一个即可添加其他模型。",
    activeFilters: "筛选 {count}",
    sortLabel: "排序",
    sortRecommended: "推荐顺序",
    sortCredits: "额度从低到高",
    sortName: "名称（A–Z）",
  },
  fr: {
    recommendedTitle: "Recommandés pour ce type de travail",
    recommendedSubtitle: "Choisissez-en un pour commencer. Changer de modèle est gratuit et toujours possible.",
    recommendedEmpty: "Aucune recommandation disponible pour le moment. Ouvrez Tous les modèles pour choisir vous-même.",
    openAllModels: "Tous les modèles",
    openAllModelsHint: "Parcourir le catalogue complet avec recherche et filtres",
    allModelsTitle: "Tous les modèles",
    backToRecommended: "Retour aux recommandations",
    filterSheetTitle: "Filtres",
    openFilters: "Filtres",
    resetAllFilters: "Tout réinitialiser",
    resultCount: "{count} modèles",
    taskAll: "Tâche : toutes",
    searchResultsTitle: "Résultats de recherche",
    clearSearch: "Effacer la recherche",
    signInToUse: "Connectez-vous pour utiliser ce modèle",
    upgradeToUse: "Passez à un forfait supérieur pour utiliser ce modèle",
    maxReached: "Vous pouvez comparer jusqu'à {max} modèles. Retirez-en un pour en ajouter un autre.",
    activeFilters: "Filtres {count}",
    sortLabel: "Trier",
    sortRecommended: "Ordre suggéré",
    sortCredits: "Coût en crédits croissant",
    sortName: "Nom (A–Z)",
  },
  de: {
    recommendedTitle: "Empfohlen für diese Art von Arbeit",
    recommendedSubtitle: "Wähle eins zum Starten. Ein Modellwechsel ist jederzeit möglich und kostenlos.",
    recommendedEmpty: "Derzeit sind keine Empfehlungen verfügbar. Öffne Alle Modelle, um selbst zu wählen.",
    openAllModels: "Alle Modelle",
    openAllModelsHint: "Den vollständigen Katalog mit Suche und Filtern durchsehen",
    allModelsTitle: "Alle Modelle",
    backToRecommended: "Zurück zu den Empfehlungen",
    filterSheetTitle: "Filter",
    openFilters: "Filter",
    resetAllFilters: "Alle zurücksetzen",
    resultCount: "{count} Modelle",
    taskAll: "Aufgabe: Alle",
    searchResultsTitle: "Suchergebnisse",
    clearSearch: "Suche löschen",
    signInToUse: "Melde dich an, um dieses Modell zu nutzen",
    upgradeToUse: "Wechsle den Tarif, um dieses Modell zu nutzen",
    maxReached: "Du kannst bis zu {max} Modelle vergleichen. Entferne eins, um ein anderes hinzuzufügen.",
    activeFilters: "Filter {count}",
    sortLabel: "Sortieren",
    sortRecommended: "Vorgeschlagene Reihenfolge",
    sortCredits: "Niedrigste Credit-Kosten zuerst",
    sortName: "Name (A–Z)",
  },
  es: {
    recommendedTitle: "Recomendados para este tipo de trabajo",
    recommendedSubtitle: "Elige uno para empezar. Cambiar de modelo es gratis y siempre posible.",
    recommendedEmpty: "No hay recomendaciones disponibles ahora mismo. Abre Todos los modelos para elegir tú mismo.",
    openAllModels: "Todos los modelos",
    openAllModelsHint: "Explora el catálogo completo con búsqueda y filtros",
    allModelsTitle: "Todos los modelos",
    backToRecommended: "Volver a las recomendaciones",
    filterSheetTitle: "Filtros",
    openFilters: "Filtros",
    resetAllFilters: "Restablecer todo",
    resultCount: "{count} modelos",
    taskAll: "Tarea: todas",
    searchResultsTitle: "Resultados de búsqueda",
    clearSearch: "Borrar búsqueda",
    signInToUse: "Inicia sesión para usar este modelo",
    upgradeToUse: "Mejora tu plan para usar este modelo",
    maxReached: "Puedes comparar hasta {max} modelos. Quita uno para añadir otro.",
    activeFilters: "Filtros {count}",
    sortLabel: "Ordenar",
    sortRecommended: "Orden sugerido",
    sortCredits: "Menor coste en créditos primero",
    sortName: "Nombre (A–Z)",
  },
  pt: {
    recommendedTitle: "Recomendados para este tipo de trabalho",
    recommendedSubtitle: "Escolha um para começar. Trocar de modelo é gratuito e sempre possível.",
    recommendedEmpty: "Não há recomendações disponíveis agora. Abra Todos os modelos para escolher você mesmo.",
    openAllModels: "Todos os modelos",
    openAllModelsHint: "Percorra o catálogo completo com busca e filtros",
    allModelsTitle: "Todos os modelos",
    backToRecommended: "Voltar às recomendações",
    filterSheetTitle: "Filtros",
    openFilters: "Filtros",
    resetAllFilters: "Redefinir tudo",
    resultCount: "{count} modelos",
    taskAll: "Tarefa: todas",
    searchResultsTitle: "Resultados da busca",
    clearSearch: "Limpar busca",
    signInToUse: "Entre para usar este modelo",
    upgradeToUse: "Faça upgrade do plano para usar este modelo",
    maxReached: "Você pode comparar até {max} modelos. Remova um para adicionar outro.",
    activeFilters: "Filtros {count}",
    sortLabel: "Ordenar",
    sortRecommended: "Ordem sugerida",
    sortCredits: "Menor custo em créditos primeiro",
    sortName: "Nome (A–Z)",
  },
};

/**
 * Recommendation reasons in the user's task language. Provider names stay off
 * these labels on purpose -- a beginner picks by "what am I doing", not by
 * "who built it".
 */
export const modelPickerUseCaseLabels: Record<
  ModelPickerLanguage,
  Record<
    | "everyday"
    | "writing"
    | "analysis"
    | "multimodal"
    | "coding"
    | "search"
    | "value"
    | "favorite"
    | "personalized"
    | "recent",
    string
  >
> = {
  en: {
    everyday: "Fast everyday questions",
    writing: "Quick summaries and drafts",
    analysis: "In-depth analysis",
    multimodal: "Image and file analysis",
    coding: "Coding and technical work",
    search: "Current information from the web",
    value: "Low-cost everyday option",
    favorite: "One of your favourites",
    personalized: "Matches the answers you gave",
    recent: "You used this recently",
  },
  ko: {
    everyday: "빠른 일상 질문",
    writing: "빠른 요약과 초안",
    analysis: "복잡한 분석",
    multimodal: "이미지·파일 분석",
    coding: "코딩과 기술 작업",
    search: "최신 웹 정보 검색",
    value: "비용 효율적인 선택",
    favorite: "즐겨찾기한 모델",
    personalized: "내가 답한 취향에 맞는 모델",
    recent: "최근에 사용한 모델",
  },
  zh: {
    everyday: "快速的日常提问",
    writing: "快速摘要与初稿",
    analysis: "复杂分析",
    multimodal: "图像与文件分析",
    coding: "编程与技术工作",
    search: "最新网络信息检索",
    value: "高性价比之选",
    favorite: "你收藏的模型",
    personalized: "符合你的回答",
    recent: "你最近用过",
  },
  fr: {
    everyday: "Questions quotidiennes rapides",
    writing: "Résumés et brouillons rapides",
    analysis: "Analyse approfondie",
    multimodal: "Analyse d'images et de fichiers",
    coding: "Code et travail technique",
    search: "Informations web récentes",
    value: "Option économique au quotidien",
    favorite: "Un de vos favoris",
    personalized: "Correspond à vos réponses",
    recent: "Utilisé récemment",
  },
  de: {
    everyday: "Schnelle Alltagsfragen",
    writing: "Schnelle Zusammenfassungen und Entwürfe",
    analysis: "Tiefgehende Analyse",
    multimodal: "Bild- und Dateianalyse",
    coding: "Programmieren und technische Arbeit",
    search: "Aktuelle Informationen aus dem Web",
    value: "Günstige Alltagsoption",
    favorite: "Einer deiner Favoriten",
    personalized: "Passt zu deinen Angaben",
    recent: "Kürzlich verwendet",
  },
  es: {
    everyday: "Preguntas rápidas del día a día",
    writing: "Resúmenes y borradores rápidos",
    analysis: "Análisis en profundidad",
    multimodal: "Análisis de imágenes y archivos",
    coding: "Programación y trabajo técnico",
    search: "Información actual de la web",
    value: "Opción económica para el día a día",
    favorite: "Uno de tus favoritos",
    personalized: "Coincide con tus respuestas",
    recent: "Lo usaste hace poco",
  },
  pt: {
    everyday: "Perguntas rápidas do dia a dia",
    writing: "Resumos e rascunhos rápidos",
    analysis: "Análise aprofundada",
    multimodal: "Análise de imagens e arquivos",
    coding: "Programação e trabalho técnico",
    search: "Informações atuais da web",
    value: "Opção econômica para o dia a dia",
    favorite: "Um dos seus favoritos",
    personalized: "Combina com suas respostas",
    recent: "Você usou recentemente",
  },
};

export const getModelPickerDescription = (
  model: Pick<AiModel, "id" | "bestFor">,
  language: ModelPickerLanguage
) => (language === "ko" ? koreanDescriptions[model.id] || model.bestFor : model.bestFor);

export const getModelPickerFeatures = (
  model: Pick<AiModel, "id" | "provider" | "reasoning" | "inputCapabilities">
): ModelPickerFeature[] => {
  const features: ModelPickerFeature[] = [];
  const webSearchSupport = getWebSearchCapability(model.id).support;
  // "unverified" is deliberately excluded -- showing the badge would imply
  // confirmed support this model doesn't officially have yet.
  if (webSearchSupport === "native" || webSearchSupport === "search-model") {
    features.push("search");
  }
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
  // Favorites depend on per-user runtime state, not a static model
  // property, so callers must filter for it themselves before/instead of
  // calling this function -- it never matches here.
  if (capability === "favorites") return false;
  if (capability === "recommended") {
    return (RECOMMENDED_MODEL_IDS as readonly string[]).includes(model.id);
  }
  if (capability === "reasoning") {
    return Boolean(model.reasoning && model.reasoning !== "none");
  }
  if (capability === "search") {
    const support = getWebSearchCapability(model.id).support;
    return support === "native" || support === "search-model";
  }
  const name = `${model.id} ${model.name}`.toLowerCase();
  return ["mini", "flash", "haiku", "small", "lite", "llama-3-1"].some((term) =>
    name.includes(term)
  );
};
