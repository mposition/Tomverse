import type { Language } from "../lib/language";

const columns = ["title", "progress", "assigning", "unknownModel", "pending", "incomplete", "details", "actualModel"] as const;
const translations = {
  en: ["Task List", "{done}/{total} complete", "Awaiting assignment", "Model unconfirmed", "Pending", "Completion unverified", "Task evidence", "Actual model"],
  ko: ["할 일", "{done}/{total} 완료", "배정 대기", "모델 미확인", "대기 중", "완료 근거 미확인", "작업 근거", "실행 모델"],
  zh: ["任务列表", "已完成 {done}/{total}", "等待分配", "模型未确认", "待处理", "完成情况未确认", "任务依据", "实际模型"],
  "zh-Hant": ["任務清單", "已完成 {done}/{total}", "等待指派", "模型未確認", "待處理", "完成狀態未確認", "任務依據", "實際模型"],
  fr: ["Liste des tâches", "{done}/{total} terminées", "En attente d’attribution", "Modèle non confirmé", "En attente", "Achèvement non vérifié", "Éléments de vérification", "Modèle utilisé"],
  de: ["Aufgabenliste", "{done}/{total} erledigt", "Zuweisung ausstehend", "Modell unbestätigt", "Ausstehend", "Abschluss unbestätigt", "Aufgabennachweise", "Verwendetes Modell"],
  es: ["Lista de tareas", "{done}/{total} completadas", "Pendiente de asignación", "Modelo sin confirmar", "Pendiente", "Finalización sin verificar", "Evidencia de la tarea", "Modelo utilizado"],
  pt: ["Lista de tarefas", "{done}/{total} concluídas", "A aguardar atribuição", "Modelo por confirmar", "Pendente", "Conclusão por verificar", "Evidências da tarefa", "Modelo usado"],
} satisfies Record<Language, readonly [string, string, string, string, string, string, string, string]>;

export function desktopTaskListCopy(language: Language) {
  const rows = Object.fromEntries(columns.map((key, index) => [key, translations[language][index]])) as Record<(typeof columns)[number], string>;
  const [task, segment, effortUnknown, apiHeader, apiReceipt] = executionDetails[language];
  return { ...rows, task, segment, effortUnknown, apiHeader, apiReceipt };
}

export const desktopPlanAnalysisCopy = {
  en: ["Request analysis", "Verified facts", "Assumptions", "Scope", "Verification", "Completion criteria"],
  ko: ["요청 분석", "확인한 사실", "가정", "작업 범위", "검증 방법", "완료 기준"],
  zh: ["请求分析", "已核实事实", "假设", "范围", "验证方法", "完成标准"],
  "zh-Hant": ["請求分析", "已核實事實", "假設", "範圍", "驗證方式", "完成標準"],
  fr: ["Analyse de la demande", "Faits vérifiés", "Hypothèses", "Périmètre", "Vérification", "Critères d’achèvement"],
  de: ["Anfrageanalyse", "Bestätigte Fakten", "Annahmen", "Umfang", "Überprüfung", "Abschlusskriterien"],
  es: ["Análisis de la solicitud", "Hechos verificados", "Supuestos", "Alcance", "Verificación", "Criterios de finalización"],
  pt: ["Análise do pedido", "Factos verificados", "Pressupostos", "Alcance", "Verificação", "Critérios de conclusão"],
} satisfies Record<Language, readonly [string, string, string, string, string, string]>;

const executionDetails = {
  en: ["Task", "Segment", "Applied effort unconfirmed", "Tomverse API response header", "Tomverse API receipt"],
  ko: ["작업", "실행 구간", "적용된 추론 강도 미확인", "Tomverse API 응답 헤더", "Tomverse API 영수증"],
  zh: ["任务", "执行分段", "实际推理强度未确认", "Tomverse API 响应头", "Tomverse API 回执"],
  "zh-Hant": ["任務", "執行區段", "實際推理強度未確認", "Tomverse API 回應標頭", "Tomverse API 收據"],
  fr: ["Tâche", "Segment", "Effort appliqué non confirmé", "En-tête de réponse Tomverse API", "Reçu Tomverse API"],
  de: ["Aufgabe", "Abschnitt", "Angewandter Denkaufwand unbestätigt", "Tomverse-API-Antwortheader", "Tomverse-API-Beleg"],
  es: ["Tarea", "Segmento", "Esfuerzo aplicado sin confirmar", "Cabecera de respuesta de Tomverse API", "Recibo de Tomverse API"],
  pt: ["Tarefa", "Segmento", "Esforço aplicado por confirmar", "Cabeçalho de resposta da Tomverse API", "Recibo da Tomverse API"],
} satisfies Record<Language, readonly [string, string, string, string, string]>;
