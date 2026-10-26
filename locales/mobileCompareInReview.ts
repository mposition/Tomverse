import type { MobileLanguage } from "./mobile";

// "Compare in Review" on a native Chat answer. The web's approved `chat.compareInReview*`
// strings, verbatim, so both surfaces name the action the same way.
type CompareInReviewCopy = { label: string; aria: string; context: string };
const copy: Record<MobileLanguage, CompareInReviewCopy> = {
  en: {"label":"Compare in Review","aria":"Compare this question across models in a new Review","context":"Earlier questions:"},
  ko: {"label":"Review로 비교","aria":"이 질문을 새 Review에서 여러 모델로 비교","context":"이전 질문:"},
  zh: {"label":"在 Review 中比较","aria":"在新的 Review 中用多个模型比较这个问题","context":"之前的问题："},
  de: {"label":"In Review vergleichen","aria":"Diese Frage in einem neuen Review über mehrere Modelle vergleichen","context":"Frühere Fragen:"},
  fr: {"label":"Comparer dans Review","aria":"Comparer cette question entre plusieurs modèles dans un nouveau Review","context":"Questions précédentes :"},
  es: {"label":"Comparar en Review","aria":"Comparar esta pregunta entre modelos en un nuevo Review","context":"Preguntas anteriores:"},
  pt: {"label":"Comparar no Review","aria":"Comparar esta pergunta entre modelos em um novo Review","context":"Perguntas anteriores:"},
};
export const mobileCompareInReviewCopy = (language: MobileLanguage) => copy[language];
