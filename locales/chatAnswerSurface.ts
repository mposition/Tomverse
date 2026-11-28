/**
 * Words for what an answer shows around its text: inline charts, the credits
 * an answer actually cost, and branching a conversation from an answer.
 *
 * A side table keyed by language (the shape locales/chatTurnTools.ts uses) so
 * these screens do not share a merge hot spot with the large locale files.
 */
import type { Language } from "@/lib/language";

export type ChatAnswerSurfaceCopy = {
  chartBar: string;
  chartLine: string;
  chartArea: string;
  chartPie: string;
  chartScatter: string;
  chartShowData: string;
  chartCategory: string;
  chartSeries: string;
  chartValue: string;
  chartShare: string;
  branchHere: string;
  branchWorking: string;
  branchBlocked: string;
  branchFailed: string;
  branchLocked: string;
  branchTemporary: string;
  branchExternal: string;
  branchProjectArchived: string;
  branchQuota: string;
  branchTitleTemplate: string;
  branchFilesTemplate: string;
};

export const chatAnswerSurfaceCopy: Record<Language, ChatAnswerSurfaceCopy> = {
  en: {
    chartBar: "Bar chart",
    chartLine: "Line chart",
    chartArea: "Area chart",
    chartPie: "Pie chart",
    chartScatter: "Scatter plot",
    chartShowData: "Show the data as a table",
    chartCategory: "Category",
    chartSeries: "Series",
    chartValue: "Value",
    chartShare: "Share",
    branchHere: "Branch to a new chat",
    branchWorking: "Branching…",
    branchBlocked: "Finish what you are sending before branching.",
    branchFailed: "Could not branch this conversation. Try again.",
    branchLocked: "A locked conversation cannot be branched.",
    branchTemporary: "A temporary chat cannot be branched.",
    branchExternal: "An imported conversation cannot be branched.",
    branchProjectArchived: "Restore the project before branching a conversation in it.",
    branchQuota: "You have reached the conversation or message storage limit.",
    branchTitleTemplate: "Branch: {title}",
    branchFilesTemplate: "[Files not copied to this conversation: {names}]",
  },
  ko: {
    chartBar: "막대 차트",
    chartLine: "선 차트",
    chartArea: "영역 차트",
    chartPie: "원형 차트",
    chartScatter: "산점도",
    chartShowData: "데이터를 표로 보기",
    chartCategory: "항목",
    chartSeries: "계열",
    chartValue: "값",
    chartShare: "비율",
    branchHere: "여기서 새 대화로",
    branchWorking: "분기하는 중…",
    branchBlocked: "보내는 중인 질문이 끝난 뒤에 분기할 수 있습니다.",
    branchFailed: "대화를 분기하지 못했습니다. 다시 시도해 주세요.",
    branchLocked: "잠긴 대화는 분기할 수 없습니다.",
    branchTemporary: "임시 대화는 분기할 수 없습니다.",
    branchExternal: "가져온 대화는 분기할 수 없습니다.",
    branchProjectArchived: "프로젝트를 복원한 뒤에 그 안의 대화를 분기할 수 있습니다.",
    branchQuota: "대화 또는 메시지 저장 한도에 도달했습니다.",
    branchTitleTemplate: "분기: {title}",
    branchFilesTemplate: "[이 대화로 복사되지 않은 파일: {names}]",
  },
  zh: {
    chartBar: "柱状图",
    chartLine: "折线图",
    chartArea: "面积图",
    chartPie: "饼图",
    chartScatter: "散点图",
    chartShowData: "以表格查看数据",
    chartCategory: "类别",
    chartSeries: "系列",
    chartValue: "数值",
    chartShare: "占比",
    branchHere: "从此处新建对话",
    branchWorking: "正在分支…",
    branchBlocked: "请等当前发送完成后再分支。",
    branchFailed: "无法分支此对话，请重试。",
    branchLocked: "已锁定的对话无法分支。",
    branchTemporary: "临时对话无法分支。",
    branchExternal: "导入的对话无法分支。",
    branchProjectArchived: "请先恢复项目，再分支其中的对话。",
    branchQuota: "已达到对话或消息的存储上限。",
    branchTitleTemplate: "分支：{title}",
    branchFilesTemplate: "[未复制到此对话的文件：{names}]",
  },
  "zh-Hant": {
    chartBar: "長條圖",
    chartLine: "折線圖",
    chartArea: "面積圖",
    chartPie: "圓餅圖",
    chartScatter: "散佈圖",
    chartShowData: "以表格檢視資料",
    chartCategory: "類別",
    chartSeries: "數列",
    chartValue: "數值",
    chartShare: "占比",
    branchHere: "從此處建立新對話",
    branchWorking: "正在分支…",
    branchBlocked: "請等目前傳送完成後再分支。",
    branchFailed: "無法分支此對話，請再試一次。",
    branchLocked: "已鎖定的對話無法分支。",
    branchTemporary: "暫時對話無法分支。",
    branchExternal: "匯入的對話無法分支。",
    branchProjectArchived: "請先還原專案，再分支其中的對話。",
    branchQuota: "已達對話或訊息的儲存上限。",
    branchTitleTemplate: "分支：{title}",
    branchFilesTemplate: "[未複製到此對話的檔案：{names}]",
  },
  fr: {
    chartBar: "Diagramme à barres",
    chartLine: "Courbe",
    chartArea: "Graphique en aires",
    chartPie: "Graphique circulaire",
    chartScatter: "Nuage de points",
    chartShowData: "Afficher les données sous forme de tableau",
    chartCategory: "Catégorie",
    chartSeries: "Série",
    chartValue: "Valeur",
    chartShare: "Part",
    branchHere: "Créer une conversation à partir d'ici",
    branchWorking: "Création de la branche…",
    branchBlocked: "Attendez la fin de l'envoi en cours avant de créer une branche.",
    branchFailed: "Impossible de créer une branche. Réessayez.",
    branchLocked: "Une conversation verrouillée ne peut pas être dupliquée en branche.",
    branchTemporary: "Une conversation temporaire ne peut pas être dupliquée en branche.",
    branchExternal: "Une conversation importée ne peut pas être dupliquée en branche.",
    branchProjectArchived: "Restaurez le projet avant de créer une branche d'une de ses conversations.",
    branchQuota: "Vous avez atteint la limite de stockage des conversations ou des messages.",
    branchTitleTemplate: "Branche : {title}",
    branchFilesTemplate: "[Fichiers non copiés dans cette conversation : {names}]",
  },
  de: {
    chartBar: "Balkendiagramm",
    chartLine: "Liniendiagramm",
    chartArea: "Flächendiagramm",
    chartPie: "Kreisdiagramm",
    chartScatter: "Streudiagramm",
    chartShowData: "Daten als Tabelle anzeigen",
    chartCategory: "Kategorie",
    chartSeries: "Reihe",
    chartValue: "Wert",
    chartShare: "Anteil",
    branchHere: "Hier neu verzweigen",
    branchWorking: "Wird verzweigt…",
    branchBlocked: "Schließe zuerst das laufende Senden ab, bevor du verzweigst.",
    branchFailed: "Die Unterhaltung konnte nicht verzweigt werden. Bitte erneut versuchen.",
    branchLocked: "Eine gesperrte Unterhaltung kann nicht verzweigt werden.",
    branchTemporary: "Ein temporärer Chat kann nicht verzweigt werden.",
    branchExternal: "Eine importierte Unterhaltung kann nicht verzweigt werden.",
    branchProjectArchived: "Stelle das Projekt wieder her, bevor du eine Unterhaltung darin verzweigst.",
    branchQuota: "Das Speicherlimit für Unterhaltungen oder Nachrichten ist erreicht.",
    branchTitleTemplate: "Zweig: {title}",
    branchFilesTemplate: "[Nicht in diese Unterhaltung kopierte Dateien: {names}]",
  },
  es: {
    chartBar: "Gráfico de barras",
    chartLine: "Gráfico de líneas",
    chartArea: "Gráfico de áreas",
    chartPie: "Gráfico circular",
    chartScatter: "Diagrama de dispersión",
    chartShowData: "Mostrar los datos como tabla",
    chartCategory: "Categoría",
    chartSeries: "Serie",
    chartValue: "Valor",
    chartShare: "Proporción",
    branchHere: "Crear una conversación desde aquí",
    branchWorking: "Creando la rama…",
    branchBlocked: "Espera a que termine el envío en curso antes de crear una rama.",
    branchFailed: "No se pudo crear la rama. Inténtalo de nuevo.",
    branchLocked: "Una conversación bloqueada no se puede ramificar.",
    branchTemporary: "Un chat temporal no se puede ramificar.",
    branchExternal: "Una conversación importada no se puede ramificar.",
    branchProjectArchived: "Restaura el proyecto antes de ramificar una conversación suya.",
    branchQuota: "Has alcanzado el límite de almacenamiento de conversaciones o mensajes.",
    branchTitleTemplate: "Rama: {title}",
    branchFilesTemplate: "[Archivos no copiados a esta conversación: {names}]",
  },
  pt: {
    chartBar: "Gráfico de barras",
    chartLine: "Gráfico de linhas",
    chartArea: "Gráfico de área",
    chartPie: "Gráfico de pizza",
    chartScatter: "Gráfico de dispersão",
    chartShowData: "Mostrar os dados como tabela",
    chartCategory: "Categoria",
    chartSeries: "Série",
    chartValue: "Valor",
    chartShare: "Proporção",
    branchHere: "Criar uma conversa a partir daqui",
    branchWorking: "Criando a ramificação…",
    branchBlocked: "Aguarde o envio em andamento terminar antes de ramificar.",
    branchFailed: "Não foi possível ramificar a conversa. Tente novamente.",
    branchLocked: "Uma conversa bloqueada não pode ser ramificada.",
    branchTemporary: "Uma conversa temporária não pode ser ramificada.",
    branchExternal: "Uma conversa importada não pode ser ramificada.",
    branchProjectArchived: "Restaure o projeto antes de ramificar uma conversa dele.",
    branchQuota: "Você atingiu o limite de armazenamento de conversas ou mensagens.",
    branchTitleTemplate: "Ramificação: {title}",
    branchFilesTemplate: "[Arquivos não copiados para esta conversa: {names}]",
  },
};
