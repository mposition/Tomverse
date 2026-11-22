import type { MobileLanguage } from "./mobile";

const en = { quickSummary: "Quick difference summary", runSummary: "Summarise the differences", close: "Close", working: "Working…" };
const translations: Partial<Record<MobileLanguage, typeof en>> = {
  "zh-Hant": { quickSummary: "快速摘要差異", runSummary: "摘要差異", close: "關閉", working: "處理中…" },
  ko: { quickSummary: "빠른 차이 요약", runSummary: "차이 요약 실행", close: "닫기", working: "처리 중…" },
  de: { quickSummary: "Unterschiede kurz zusammenfassen", runSummary: "Unterschiede zusammenfassen", close: "Schließen", working: "Wird bearbeitet…" },
  fr: { quickSummary: "Résumé rapide des différences", runSummary: "Résumer les différences", close: "Fermer", working: "En cours…" },
  es: { quickSummary: "Resumen rápido de diferencias", runSummary: "Resumir diferencias", close: "Cerrar", working: "Procesando…" },
  pt: { quickSummary: "Resumo rápido das diferenças", runSummary: "Resumir diferenças", close: "Fechar", working: "Processando…" },
  zh: { quickSummary: "快速总结差异", runSummary: "总结差异", close: "关闭", working: "处理中…" },
};
export const nativeWorkspaceCopy = (language: MobileLanguage) => translations[language] ?? en;
