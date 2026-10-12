import type { Language } from "@/lib/language";

export type ChatWorkspaceProduct = "chat" | "review";

type ProductCopy = {
  shortLabel: string;
  name: string;
  feature: string;
  description: string;
  open: string;
};

export type ChatProductUiCopy = {
  selectorLabel: string;
  landingIntro: string;
  unavailable: string;
  signInToOpenChat: string;
  switchPendingDescription: string;
  chat: ProductCopy;
  review: ProductCopy;
};

/**
 * Product names and boundaries shared by the workspace switcher and landing
 * entry. Smart Adaptive is a Chat feature, while direct model choice and
 * side-by-side answers belong to Review. Neither description promises a
 * quality ranking or changes the stored product of an existing conversation.
 */
export const chatProductUiCopy: Readonly<Record<Language, ChatProductUiCopy>> = {
  en: {
    selectorLabel: "Choose a Tomverse product",
    landingIntro: "Use Chat for one adaptive conversation, or Review to compare selected models side by side.",
    unavailable: "Tomverse Chat is not available for this account yet.",
    signInToOpenChat: "Sign in for Chat",
    switchPendingDescription: "Wait for the current action to finish before switching products.",
    chat: {
      shortLabel: "Chat",
      name: "Tomverse Chat",
      feature: "Smart Adaptive",
      description: "Question refinement and automatic model selection for each message.",
      open: "Open Chat",
    },
    review: {
      shortLabel: "Review",
      name: "Tomverse Review",
      feature: "Model Compare",
      description: "Choose models directly and compare their answers side by side.",
      open: "Open Review",
    },
  },
  ko: {
    selectorLabel: "Tomverse 제품 선택",
    landingIntro: "Chat에서는 하나의 대화를 스마트하게 이어가고, Review에서는 선택한 모델의 답변을 나란히 비교하세요.",
    unavailable: "이 계정에는 아직 Tomverse Chat이 제공되지 않습니다.",
    signInToOpenChat: "로그인하고 Chat 열기",
    switchPendingDescription: "현재 작업이 끝난 뒤 제품을 전환할 수 있습니다.",
    chat: {
      shortLabel: "Chat",
      name: "Tomverse Chat",
      feature: "스마트 자동",
      description: "질문 다듬기와 메시지별 자동 모델 선택.",
      open: "Chat 열기",
    },
    review: {
      shortLabel: "Review",
      name: "Tomverse Review",
      feature: "모델 비교",
      description: "모델을 직접 선택하고 답변을 나란히 비교.",
      open: "Review 열기",
    },
  },
  zh: {
    selectorLabel: "选择 Tomverse 产品",
    landingIntro: "使用 Chat 进行自适应单一对话，或使用 Review 并排比较所选模型。",
    unavailable: "此账户暂时无法使用 Tomverse Chat。",
    signInToOpenChat: "登录后打开 Chat",
    switchPendingDescription: "请等待当前操作完成后再切换产品。",
    chat: {
      shortLabel: "Chat",
      name: "Tomverse Chat",
      feature: "智能自动",
      description: "优化问题，并为每条消息自动选择模型。",
      open: "打开 Chat",
    },
    review: {
      shortLabel: "Review",
      name: "Tomverse Review",
      feature: "模型比较",
      description: "直接选择模型，并排比较回答。",
      open: "打开 Review",
    },
  },
  fr: {
    selectorLabel: "Choisir un produit Tomverse",
    landingIntro: "Utilisez Chat pour une conversation adaptative, ou Review pour comparer côte à côte les modèles choisis.",
    unavailable: "Tomverse Chat n’est pas encore disponible pour ce compte.",
    signInToOpenChat: "Se connecter pour Chat",
    switchPendingDescription: "Attendez la fin de l’action en cours avant de changer de produit.",
    chat: {
      shortLabel: "Chat",
      name: "Tomverse Chat",
      feature: "Adaptation intelligente",
      description: "Affinement des questions et sélection automatique du modèle pour chaque message.",
      open: "Ouvrir Chat",
    },
    review: {
      shortLabel: "Review",
      name: "Tomverse Review",
      feature: "Comparaison de modèles",
      description: "Choisissez directement les modèles et comparez leurs réponses côte à côte.",
      open: "Ouvrir Review",
    },
  },
  de: {
    selectorLabel: "Tomverse-Produkt auswählen",
    landingIntro: "Nutzen Sie Chat für eine adaptive Unterhaltung oder Review, um ausgewählte Modelle nebeneinander zu vergleichen.",
    unavailable: "Tomverse Chat ist für dieses Konto noch nicht verfügbar.",
    signInToOpenChat: "Für Chat anmelden",
    switchPendingDescription: "Warten Sie, bis die aktuelle Aktion abgeschlossen ist, bevor Sie das Produkt wechseln.",
    chat: {
      shortLabel: "Chat",
      name: "Tomverse Chat",
      feature: "Intelligente Automatik",
      description: "Fragen verfeinern und für jede Nachricht automatisch ein Modell auswählen.",
      open: "Chat öffnen",
    },
    review: {
      shortLabel: "Review",
      name: "Tomverse Review",
      feature: "Modellvergleich",
      description: "Modelle direkt auswählen und ihre Antworten nebeneinander vergleichen.",
      open: "Review öffnen",
    },
  },
  es: {
    selectorLabel: "Elegir un producto de Tomverse",
    landingIntro: "Usa Chat para una conversación adaptativa o Review para comparar en paralelo los modelos elegidos.",
    unavailable: "Tomverse Chat aún no está disponible para esta cuenta.",
    signInToOpenChat: "Iniciar sesión para Chat",
    switchPendingDescription: "Espera a que termine la acción actual antes de cambiar de producto.",
    chat: {
      shortLabel: "Chat",
      name: "Tomverse Chat",
      feature: "Adaptación inteligente",
      description: "Refina las preguntas y selecciona automáticamente un modelo para cada mensaje.",
      open: "Abrir Chat",
    },
    review: {
      shortLabel: "Review",
      name: "Tomverse Review",
      feature: "Comparación de modelos",
      description: "Elige modelos directamente y compara sus respuestas en paralelo.",
      open: "Abrir Review",
    },
  },
  pt: {
    selectorLabel: "Escolher um produto Tomverse",
    landingIntro: "Use o Chat para uma conversa adaptável ou o Review para comparar lado a lado os modelos escolhidos.",
    unavailable: "O Tomverse Chat ainda não está disponível para esta conta.",
    signInToOpenChat: "Entrar para usar o Chat",
    switchPendingDescription: "Aguarde a ação atual terminar antes de trocar de produto.",
    chat: {
      shortLabel: "Chat",
      name: "Tomverse Chat",
      feature: "Adaptação inteligente",
      description: "Refine perguntas e selecione automaticamente um modelo para cada mensagem.",
      open: "Abrir Chat",
    },
    review: {
      shortLabel: "Review",
      name: "Tomverse Review",
      feature: "Comparação de modelos",
      description: "Escolha modelos diretamente e compare as respostas lado a lado.",
      open: "Abrir Review",
    },
  },
};

export const localizedProductHref = (
  product: ChatWorkspaceProduct,
  language: Language
): string => `/${product}?lang=${encodeURIComponent(language)}`;
