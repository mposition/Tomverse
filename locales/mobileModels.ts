import type { MobileLanguage } from "./mobile";

const copies = {
  en: { loadFailed: "Models could not be loaded. Please try again.", capabilityFailed: "Automatic model selection is temporarily unavailable. You can choose a model manually.", retry: "Try again" },
  ko: { loadFailed: "모델을 불러오지 못했습니다. 다시 시도해 주세요.", capabilityFailed: "자동 모델 선택을 일시적으로 사용할 수 없습니다. 모델을 직접 선택할 수 있습니다.", retry: "다시 시도" },
  zh: { loadFailed: "无法加载模型，请重试。", capabilityFailed: "自动模型选择暂不可用，您可以手动选择模型。", retry: "重试" },
  de: { loadFailed: "Modelle konnten nicht geladen werden. Bitte versuchen Sie es erneut.", capabilityFailed: "Die automatische Modellauswahl ist vorübergehend nicht verfügbar. Sie können ein Modell manuell wählen.", retry: "Erneut versuchen" },
  fr: { loadFailed: "Impossible de charger les modèles. Réessayez.", capabilityFailed: "La sélection automatique est temporairement indisponible. Vous pouvez choisir un modèle manuellement.", retry: "Réessayer" },
  es: { loadFailed: "No se pudieron cargar los modelos. Inténtalo de nuevo.", capabilityFailed: "La selección automática no está disponible temporalmente. Puedes elegir un modelo manualmente.", retry: "Reintentar" },
  pt: { loadFailed: "Não foi possível carregar os modelos. Tente novamente.", capabilityFailed: "A seleção automática está temporariamente indisponível. Pode escolher um modelo manualmente.", retry: "Tentar novamente" },
};
export const mobileModelsCopy = (language: MobileLanguage) => copies[language];
