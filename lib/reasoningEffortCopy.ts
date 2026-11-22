import type { Language } from "@/lib/language";

type Copy = { title: string; low: string; default: string; high: string; question: string; auto: string; unavailable: string };
export const reasoningEffortCopy: Record<Language, Copy> = {
    en: { title: "Reasoning effort", low: "Low", default: "Default", high: "High", question: "Applies to this question.", auto: "Smart Adaptive picks the model for your question. If it cannot use this level, it uses its default.", unavailable: "This effort is unavailable for the selected models. Choose Default or change models." },
    ko: { title: "사고 수준", low: "낮음", default: "기본", high: "높음", question: "이번 질문에 적용됩니다.", auto: "스마트 자동이 질문에 맞는 모델을 고릅니다. 해당 모델이 이 수준을 지원하지 않으면 기본값을 적용합니다.", unavailable: "선택한 모델에는 이 사고 수준을 적용할 수 없습니다. 기본값을 사용하거나 모델을 변경하세요." },
    zh: { title: "思考级别", low: "低", default: "默认", high: "高", question: "适用于本次提问。", auto: "智能自动为问题选择模型。如果该模型不支持此级别，将使用默认设置。", unavailable: "所选模型无法使用此级别。请选择默认级别或更换模型。" },
    "zh-Hant": { title: "思考程度", low: "低", default: "預設", high: "高", question: "適用於本次提問。", auto: "智慧自動為問題選取模型。如果該模型不支援此程度，會使用預設設定。", unavailable: "所選模型無法使用此程度。請選擇預設值或更換模型。" },
    de: { title: "Denkniveau", low: "Niedrig", default: "Standard", high: "Hoch", question: "Gilt für diese Frage.", auto: "Smart Adaptive wählt ein Modell für die Frage. Unterstützt es diese Stufe nicht, gilt seine Standardeinstellung.", unavailable: "Dieses Niveau ist für die gewählten Modelle nicht verfügbar. Wähle Standard oder andere Modelle." },
    fr: { title: "Niveau de raisonnement", low: "Faible", default: "Par défaut", high: "Élevé", question: "Pour cette question.", auto: "Smart Adaptive choisit le modèle pour la question. Si le niveau est indisponible, le modèle utilise son réglage par défaut.", unavailable: "Ce niveau est indisponible pour les modèles sélectionnés. Choisissez le niveau par défaut ou changez de modèles." },
    es: { title: "Nivel de razonamiento", low: "Bajo", default: "Predeterminado", high: "Alto", question: "Se aplica a esta pregunta.", auto: "Smart Adaptive elige un modelo para la pregunta. Si no admite este nivel, utiliza su configuración predeterminada.", unavailable: "Los modelos seleccionados no admiten este nivel. Elige el nivel predeterminado o cambia de modelos." },
    pt: { title: "Nível de raciocínio", low: "Baixo", default: "Padrão", high: "Alto", question: "Aplica-se a esta pergunta.", auto: "O Smart Adaptive escolhe um modelo compatível com este nível.", unavailable: "Os modelos selecionados não aceitam esse nível. Use o padrão ou mude de modelo." },
};
