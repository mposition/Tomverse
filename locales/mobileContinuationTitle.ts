import type { MobileLanguage } from "./mobile";

// The existing web continuation.untitledFrom copy, also used by native history.
export const mobileContinuationTitle: Record<MobileLanguage, string> = {
  en: "Continued from {provider} · {date}",
  ko: "{provider}에서 이어온 대화 · {date}",
  zh: "从 {provider} 继续的对话 · {date}",
  de: "Fortgesetzt aus {provider} · {date}",
  fr: "Suite de {provider} · {date}",
  es: "Continuado desde {provider} · {date}",
  pt: "Continuado de {provider} · {date}",
};
