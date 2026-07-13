import type { Language } from "@/components/LanguageProvider";

export const statusNewTabCopy: Record<Language, string> = {
  en: "opens in a new tab",
  ko: "새 탭에서 열림",
  zh: "在新标签页中打开",
  fr: "s’ouvre dans un nouvel onglet",
  de: "öffnet sich in einem neuen Tab",
  es: "se abre en una pestaña nueva",
  pt: "abre em uma nova aba",
};

export const statusLinkLabel = (label: string, language: Language) =>
  `${label} (${statusNewTabCopy[language]})`;
