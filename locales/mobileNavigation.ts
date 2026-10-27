import type { MobileLanguage } from "./mobile";

export const mobileNavigationCopy: Record<MobileLanguage, { returnToChat: string; home: string }> = {
  en: { returnToChat: "Return to conversation", home: "Tomverse home" },
  ko: { returnToChat: "대화로 돌아가기", home: "Tomverse 메인 화면" },
  zh: { returnToChat: "返回对话", home: "Tomverse 主页" },
  de: { returnToChat: "Zurück zum Gespräch", home: "Tomverse-Startseite" },
  fr: { returnToChat: "Revenir à la conversation", home: "Accueil Tomverse" },
  pt: { returnToChat: "Voltar à conversa", home: "Início do Tomverse" },
  es: { returnToChat: "Volver a la conversación", home: "Inicio de Tomverse" },
};
