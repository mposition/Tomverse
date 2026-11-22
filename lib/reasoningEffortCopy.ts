import type { Language } from "@/lib/language";
import type { ReasoningEffort } from "@/lib/reasoningEffort";

export type ReasoningEffortCopy = Record<ReasoningEffort, string> & {
    title: string;
    options: Record<ReasoningEffort, readonly [label: string, description: string]>;
    preferenceHint: string;
    auto: string;
    review: string;
    unavailable: string;
};

export const reasoningEffortCopy: Record<Language, ReasoningEffortCopy> = {
    en: {
        title: "Reasoning effort", low: "Low", default: "Default", high: "High",
        options: {
            low: ["Quick", "Less reasoning for quicker replies"],
            default: ["Balanced", "Your model’s default speed and depth"],
            high: ["Deep", "More time for a thorough answer"],
        },
        preferenceHint: "Applies to future questions until you change it.",
        auto: "If a model doesn’t support this level, only that reply uses the model’s default.",
        review: "All selected models are asked to use the same level.",
        unavailable: "This effort is unavailable for the selected models. Choose Balanced or change models.",
    },
    ko: {
        title: "사고 수준", low: "낮음", default: "기본", high: "높음",
        options: {
            low: ["빠르게", "가볍게 생각해 빠른 답변"],
            default: ["균형 있게", "모델 기본 속도와 깊이"],
            high: ["깊이 있게", "시간을 들여 꼼꼼한 답변"],
        },
        preferenceHint: "고른 수준은 다음 질문에도 적용돼요.",
        auto: "모델이 지원하지 않으면 해당 답변에만 기본 수준을 적용해요.",
        review: "선택한 모델 모두에 같은 수준을 요청합니다.",
        unavailable: "선택한 모델에는 이 사고 수준을 적용할 수 없습니다. ‘균형 있게’를 선택하거나 모델을 변경하세요.",
    },
    zh: {
        title: "思考级别", low: "低", default: "默认", high: "高",
        options: {
            low: ["快速回应", "简化推理，更快给出回答"],
            default: ["平衡", "使用模型默认的速度与深度"],
            high: ["深入思考", "多花一些时间，给出更周全的回答"],
        },
        preferenceHint: "更改前，所选级别将继续用于后续提问。",
        auto: "如果模型不支持此级别，仅该次回答使用模型的默认设置。",
        review: "所有选中的模型都会收到同一级别的请求。",
        unavailable: "所选模型无法使用此级别。请选择“平衡”或更换模型。",
    },
    "zh-Hant": {
        title: "思考程度", low: "低", default: "預設", high: "高",
        options: {
            low: ["快速回覆", "簡化推理，更快給出回覆"],
            default: ["平衡", "使用模型預設的速度與深度"],
            high: ["深入思考", "多花一些時間，給出更周全的回覆"],
        },
        preferenceHint: "變更前，所選程度將繼續用於後續提問。",
        auto: "如果模型不支援此程度，僅該次回覆使用模型的預設設定。",
        review: "所有選取的模型都會收到同一程度的請求。",
        unavailable: "所選模型無法使用此程度。請選擇「平衡」或更換模型。",
    },
    de: {
        title: "Denkniveau", low: "Niedrig", default: "Standard", high: "Hoch",
        options: {
            low: ["Schnell", "Weniger Denkaufwand für schnellere Antworten"],
            default: ["Ausgewogen", "Standardtempo und Denktiefe des Modells"],
            high: ["Gründlich", "Mehr Zeit für eine gründliche Antwort"],
        },
        preferenceHint: "Gilt auch für weitere Fragen, bis du die Einstellung änderst.",
        auto: "Unterstützt ein Modell diese Stufe nicht, gilt nur für diese Antwort seine Standardeinstellung.",
        review: "Für alle gewählten Modelle wird dieselbe Stufe angefragt.",
        unavailable: "Dieses Niveau ist für die gewählten Modelle nicht verfügbar. Wähle „Ausgewogen“ oder andere Modelle.",
    },
    fr: {
        title: "Niveau de raisonnement", low: "Faible", default: "Par défaut", high: "Élevé",
        options: {
            low: ["Rapide", "Moins de raisonnement pour répondre plus vite"],
            default: ["Équilibré", "Vitesse et profondeur par défaut du modèle"],
            high: ["Approfondi", "Plus de temps pour une réponse approfondie"],
        },
        preferenceHint: "Ce niveau s’applique aux prochaines questions jusqu’à ce que vous le changiez.",
        auto: "Si le modèle ne propose pas ce niveau, seule cette réponse utilise son réglage par défaut.",
        review: "Le même niveau est demandé à tous les modèles sélectionnés.",
        unavailable: "Ce niveau est indisponible pour les modèles sélectionnés. Choisissez « Équilibré » ou changez de modèles.",
    },
    es: {
        title: "Nivel de razonamiento", low: "Bajo", default: "Predeterminado", high: "Alto",
        options: {
            low: ["Rápido", "Menos razonamiento para responder antes"],
            default: ["Equilibrado", "Velocidad y profundidad predeterminadas del modelo"],
            high: ["A fondo", "Más tiempo para una respuesta más elaborada"],
        },
        preferenceHint: "Se aplica a las próximas preguntas hasta que lo cambies.",
        auto: "Si el modelo no admite este nivel, solo esa respuesta usa su configuración predeterminada.",
        review: "Se solicita el mismo nivel a todos los modelos seleccionados.",
        unavailable: "Los modelos seleccionados no admiten este nivel. Elige «Equilibrado» o cambia de modelos.",
    },
    pt: {
        title: "Nível de raciocínio", low: "Baixo", default: "Padrão", high: "Alto",
        options: {
            low: ["Rápido", "Menos raciocínio para responder mais rápido"],
            default: ["Equilibrado", "Velocidade e profundidade padrão do modelo"],
            high: ["Aprofundado", "Mais tempo para uma resposta cuidadosa"],
        },
        preferenceHint: "Aplica-se às próximas perguntas até você mudar o nível.",
        auto: "Se o modelo não oferecer este nível, só essa resposta usa a configuração padrão dele.",
        review: "O mesmo nível é solicitado a todos os modelos selecionados.",
        unavailable: "Os modelos selecionados não aceitam esse nível. Escolha “Equilibrado” ou troque de modelos.",
    },
};
