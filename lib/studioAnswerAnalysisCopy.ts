import type { Language } from "@/lib/language";

const en = {
  start: "Analyze answers with Tomverse", view: "View analysis", title: "Tomverse answer analysis",
  intro: "Compare perspectives and check their sources.", summary: "Summary", detail: "Detailed review",
  saved: "Saved analysis", local: "Kept in this conversation", reuse: "These tabs share the same analysis.",
  checking: "Checking for saved analysis…", running: "Reviewing the answers…", progress: "Comparing the answers and their supporting quotes.",
  background: "You can close this window. The analysis will keep running.", wait: "Available when at least two answers have finished.",
  ready: "See the differences and supporting sources in one place.", failed: "Analysis is unavailable right now. Try again, or check your access.", retry: "Try again",
  differences: "Where the answers differ", consensus: "What they agree on", models: "Each model’s perspective", sources: "Review findings and sources",
  empty: "No differences were reported. See the detailed review for context.", close: "Close", external: "Web verification is a separate action. Opening this analysis does not search the web.",
  disclaimer: "This compares the supplied answers. Agreement does not establish that a claim is true.", signIn: "Sign in", reviewer: "Reviewer",
};
export const studioAnswerAnalysisCopy: Record<Language, typeof en> = {
  en,
  ko: {
    start: "Tomverse 답변 분석", view: "분석 결과 보기", title: "Tomverse 답변 분석",
    intro: "답변의 차이를 살펴보고, 근거까지 확인하세요.", summary: "요약", detail: "상세 검토",
    saved: "저장된 분석", local: "현재 대화에서 보관", reuse: "같은 분석 결과를 보여드립니다.",
    checking: "저장된 분석을 확인하고 있어요…", running: "답변을 검토하고 있어요…", progress: "답변 사이의 차이와 인용된 근거를 함께 살펴보고 있습니다.",
    background: "창을 닫아도 분석은 계속됩니다. 완료되면 결과를 다시 열어보세요.", wait: "두 개 이상의 답변이 완성되면 분석할 수 있어요.",
    ready: "답변의 차이와 근거를 한곳에서 확인하세요.", failed: "지금은 분석을 이용할 수 없습니다. 잠시 후 다시 시도하거나 이용 가능 여부를 확인해 주세요.", retry: "다시 시도",
    differences: "답변이 갈리는 지점", consensus: "공통으로 이야기한 내용", models: "모델별 관점", sources: "검토 내용과 원문 확인",
    empty: "보고된 차이가 없습니다. 상세 검토에서 맥락을 확인하세요.", close: "닫기", external: "웹 확인은 별도로 실행합니다. 분석 결과를 여는 것만으로 웹을 검색하지 않습니다.",
    disclaimer: "제공된 답변을 비교한 결과입니다. 답변이 일치한다고 사실로 확인된 것은 아닙니다.", signIn: "로그인", reviewer: "검토자",
  },
  zh: { ...en, start: "用 Tomverse 分析回答", view: "查看分析", title: "Tomverse 回答分析", summary: "摘要", detail: "详细审查", saved: "已保存的分析", running: "正在审查回答…", checking: "正在查找已保存的分析…", close: "关闭", retry: "重试" },
  fr: { ...en, start: "Analyser avec Tomverse", view: "Voir l’analyse", title: "Analyse des réponses Tomverse", summary: "Résumé", detail: "Examen détaillé", saved: "Analyse enregistrée", running: "Examen des réponses…", checking: "Recherche de l’analyse enregistrée…", close: "Fermer", retry: "Réessayer" },
  de: { ...en, start: "Antworten mit Tomverse analysieren", view: "Analyse ansehen", title: "Tomverse Antwortanalyse", summary: "Zusammenfassung", detail: "Detaillierte Prüfung", saved: "Gespeicherte Analyse", running: "Antworten werden geprüft…", checking: "Gespeicherte Analyse wird gesucht…", close: "Schließen", retry: "Erneut versuchen" },
  es: { ...en, start: "Analizar con Tomverse", view: "Ver análisis", title: "Análisis de respuestas Tomverse", summary: "Resumen", detail: "Revisión detallada", saved: "Análisis guardado", running: "Revisando las respuestas…", checking: "Buscando un análisis guardado…", close: "Cerrar", retry: "Reintentar" },
  pt: { ...en, start: "Analisar com Tomverse", view: "Ver análise", title: "Análise de respostas Tomverse", summary: "Resumo", detail: "Revisão detalhada", saved: "Análise salva", running: "Revisando as respostas…", checking: "Buscando a análise salva…", close: "Fechar", retry: "Tentar novamente" },
};
