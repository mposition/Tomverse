import type { Language } from "../lib/language";

const fields = ["title", "summary", "chat", "chatMemory", "accountSettings", "codeMemory", "codeTransfer", "selectedOnly",
  "providers", "providerPolicy", "viewPolicy", "localHistory", "historyDetail", "manageHistory", "memoriesUsed"] as const;
const translations = {
  en: ["Memory and privacy", "Manage data use in Chat and Code.", "Chat", "Uses your Tomverse account memory settings.", "Account settings",
    "Account memory in Code", "Share an excerpt by selecting and confirming it.", "Selected context only", "Provider data settings",
    "The provider’s policy applies to your account and execution route.", "View policy", "Local task history",
    "Manage the Code history on this computer.", "Manage history", "Memories used · {count}"],
  ko: ["메모리와 개인정보", "Chat과 Code의 데이터 사용을 관리합니다.", "일반 Chat", "Tomverse 계정의 메모리 설정을 따릅니다.", "계정 설정",
    "Code의 계정 메모리", "사용자가 발췌 내용을 선택하고 확인한 뒤 전달합니다.", "선택한 문맥만 전달", "공급자 데이터 설정",
    "계정과 실행 경로에 해당하는 공급자 정책이 적용됩니다.", "정책 보기", "로컬 작업 기록",
    "이 컴퓨터의 Code 작업 기록을 관리합니다.", "기록 관리", "사용된 메모리 · {count}개"],
  zh: ["记忆与隐私", "管理 Chat 和 Code 的数据使用。", "普通 Chat", "遵循 Tomverse 账户的记忆设置。", "账户设置",
    "Code 中的账户记忆", "选择并确认摘录后即可分享。", "仅发送选定的上下文", "供应商数据设置",
    "适用与账户和执行路径对应的供应商政策。", "查看政策", "本地任务记录",
    "管理此电脑上的 Code 记录。", "管理记录", "已使用记忆 · {count} 条"],
  "zh-Hant": ["記憶與隱私權", "管理 Chat 與 Code 的資料使用。", "一般 Chat", "遵循 Tomverse 帳戶的記憶設定。", "帳戶設定",
    "Code 中的帳戶記憶", "選取並確認摘錄後即可分享。", "僅傳送已選取的內容", "供應商資料設定",
    "適用帳戶和執行路徑對應的供應商政策。", "查看政策", "本機工作記錄",
    "管理此電腦上的 Code 記錄。", "管理記錄", "已使用記憶 · {count} 筆"],
  fr: ["Mémoire et confidentialité", "Gérez l’utilisation des données dans Chat et Code.", "Chat", "Utilise les réglages de mémoire de votre compte Tomverse.", "Réglages du compte",
    "Mémoire du compte dans Code", "Sélectionnez puis confirmez l’extrait à partager.", "Contexte sélectionné uniquement", "Données des fournisseurs",
    "La politique du fournisseur s’applique à votre compte et au mode d’exécution.", "Voir la politique", "Historique local des tâches",
    "Gérez l’historique de Code sur cet ordinateur.", "Gérer l’historique", "Souvenirs utilisés · {count}"],
  de: ["Gedächtnis und Datenschutz", "Verwalten Sie die Datennutzung in Chat und Code.", "Chat", "Verwendet die Gedächtniseinstellungen Ihres Tomverse-Kontos.", "Kontoeinstellungen",
    "Kontogedächtnis in Code", "Wählen und bestätigen Sie einen Auszug, um ihn zu teilen.", "Nur ausgewählter Kontext", "Dateneinstellungen des Anbieters",
    "Die Richtlinien des Anbieters gelten für Ihr Konto und den Ausführungsweg.", "Richtlinie ansehen", "Lokaler Aufgabenverlauf",
    "Verwalten Sie den Code-Verlauf auf diesem Computer.", "Verlauf verwalten", "Verwendete Erinnerungen · {count}"],
  es: ["Memoria y privacidad", "Gestiona el uso de datos en Chat y Code.", "Chat", "Usa la configuración de memoria de tu cuenta de Tomverse.", "Configuración de la cuenta",
    "Memoria de cuenta en Code", "Selecciona y confirma un fragmento para compartirlo.", "Solo el contexto seleccionado", "Datos del proveedor",
    "La política del proveedor se aplica a tu cuenta y a la ruta de ejecución.", "Ver política", "Historial local de tareas",
    "Gestiona el historial de Code en este ordenador.", "Gestionar historial", "Recuerdos utilizados · {count}"],
  pt: ["Memória e privacidade", "Gira a utilização de dados no Chat e no Code.", "Chat", "Usa as definições de memória da conta Tomverse.", "Definições da conta",
    "Memória da conta no Code", "Selecione e confirme um excerto para o partilhar.", "Apenas o contexto selecionado", "Dados do fornecedor",
    "Aplica-se a política do fornecedor para a sua conta e o modo de execução.", "Ver política", "Histórico local de tarefas",
    "Gira o histórico do Code neste computador.", "Gerir histórico", "Memórias usadas · {count}"],
} as const satisfies Record<Language, readonly string[]>;

const contextChanged = {
  en: "The Chat context changed before a reply could start. Your question is saved.",
  ko: "답변을 시작하기 전에 Chat 문맥이 변경됐습니다. 질문은 저장됐습니다.",
  zh: "开始回复前，Chat 上下文发生了变化。你的问题已保存。",
  "zh-Hant": "開始回覆前，Chat 內容已變更。你的問題已儲存。",
  fr: "Le contexte de Chat a changé avant le début de la réponse. Votre question est enregistrée.",
  de: "Der Chat-Kontext hat sich vor Beginn der Antwort geändert. Ihre Frage wurde gespeichert.",
  es: "El contexto de Chat cambió antes de que empezara la respuesta. Tu pregunta se ha guardado.",
  pt: "O contexto do Chat mudou antes do início da resposta. A sua pergunta foi guardada.",
} satisfies Record<Language, string>;

export function desktopPrivacyCopy(language: Language) {
  const labels = Object.fromEntries(fields.map((field, index) => [field, translations[language][index]])) as Record<(typeof fields)[number], string>;
  return { ...labels, contextChanged: contextChanged[language] };
}
