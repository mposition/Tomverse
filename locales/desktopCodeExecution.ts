import type { Language } from "../lib/language";

type Copy = {
  heading: string;
  nextTasks: string;
  preference: string;
  description: string;
  providerCli: string;
  cliUnavailable: string;
  apiRequired: string;
  useApi: string;
  cliFixture: string;
  automatic: string;
  automaticDetail: string;
  awaitingVerification: string;
  destination: string;
  destinationDetail: string;
  apiCreditCap: string;
  creditDetail: string;
  transfer: string;
  transferSummary: string;
  transferChanges: string;
  connectSettings: string;
  settingsFailed: string;
  model: string;
  unset: string;
  credits: string;
  on: string;
  off: string;
  save: string;
  review: string;
};

export const desktopCodeExecutionCopy = {
  ko: {
    heading: "실행 방식과 한도", nextTasks: "선호하는 방식을 저장하면 새 Code 작업부터 적용됩니다.",
    preference: "선호 실행 방식", description: "API 또는 연결된 공급자 CLI를 기본으로 사용",
    providerCli: "공급자 CLI", cliUnavailable: "{cli} 연결이 필요합니다.",
    apiRequired: "이 모델을 사용하려면 Tomverse API를 선택하세요.", useApi: "Tomverse API 사용",
    cliFixture: "{cli} · 로컬 시험",
    automatic: "한도 소진 시 자동 전환", automaticDetail: "확인된 소진에만 적용합니다.",
    awaitingVerification: "설정을 저장했습니다. 전환하려면 한도와 결제 출처를 확인해야 합니다.",
    destination: "대체 실행 경로", destinationDetail: "현재까지의 작업을 이어갈 실행 방식과 모델",
    apiCreditCap: "API 작업 상한", creditDetail: "API로 전환할 때 적용을 요청할 크레딧 상한",
    transfer: "전송 범위", transferSummary: "이어가기에 필요한 작업 요약만 전송", transferChanges: "필요한 작업 요약과 파일 변경 전송",
    connectSettings: "전환 설정을 저장하려면 Code 키를 연결하세요.", settingsFailed: "전환 설정을 저장하지 못했습니다.",
    model: "대체 모델", unset: "설정 안 됨", credits: "크레딧", on: "켜짐", off: "꺼짐", save: "저장", review: "확인",
  },
  en: {
    heading: "Execution and limits", nextTasks: "Saved preferences apply to new Code tasks.",
    preference: "Preferred execution mode", description: "Use the API or a connected provider CLI by default",
    providerCli: "Provider CLI", cliUnavailable: "Connect {cli} to use this model.",
    apiRequired: "Choose Tomverse API to use this model.", useApi: "Use Tomverse API",
    cliFixture: "{cli} · Local test",
    automatic: "Switch automatically when limits are reached", automaticDetail: "Applies only after confirmed exhaustion.",
    awaitingVerification: "Preference saved. Switching requires verified limits and billing.",
    destination: "Fallback destination", destinationDetail: "Execution mode and model for continuing the task",
    apiCreditCap: "API task limit", creditDetail: "Requested credit limit for fallback through the API",
    transfer: "Transfer scope", transferSummary: "Send the task summary needed to continue", transferChanges: "Send the task summary and file changes needed to continue",
    connectSettings: "Connect a Code key to save fallback settings.", settingsFailed: "Unable to save fallback settings.",
    model: "Fallback model", unset: "Not set", credits: "credits", on: "On", off: "Off", save: "Save", review: "Review",
  },
  zh: {
    heading: "执行方式和限额", nextTasks: "保存的偏好设置将应用于新的 Code 任务。",
    preference: "首选执行方式", description: "默认使用 API 或已连接的供应商 CLI",
    providerCli: "供应商 CLI", cliUnavailable: "请连接 {cli} 以使用此模型。",
    apiRequired: "请选择 Tomverse API 以使用此模型。", useApi: "使用 Tomverse API",
    cliFixture: "{cli} · 本地测试",
    automatic: "额度耗尽时自动切换", automaticDetail: "仅在确认额度耗尽后适用。",
    awaitingVerification: "已保存偏好。切换前须验证额度和计费方式。",
    destination: "备用执行方式", destinationDetail: "继续任务所用的执行方式和模型",
    apiCreditCap: "API 任务限额", creditDetail: "切换至 API 时申请使用的积分上限",
    transfer: "传输范围", transferSummary: "发送继续任务所需的摘要", transferChanges: "发送继续任务所需的摘要和文件更改",
    connectSettings: "连接 Code 密钥以保存切换设置。", settingsFailed: "无法保存切换设置。",
    model: "备用模型", unset: "未设置", credits: "积分", on: "开启", off: "关闭", save: "保存", review: "查看",
  },
  "zh-Hant": {
    heading: "執行方式和限額", nextTasks: "儲存的偏好設定將套用至新的 Code 工作。",
    preference: "偏好的執行方式", description: "預設使用 API 或已連線的供應商 CLI",
    providerCli: "供應商 CLI", cliUnavailable: "請連線至 {cli} 以使用此模型。",
    apiRequired: "請選擇 Tomverse API 以使用此模型。", useApi: "使用 Tomverse API",
    cliFixture: "{cli} · 本機測試",
    automatic: "額度耗盡時自動切換", automaticDetail: "僅在確認額度耗盡後適用。",
    awaitingVerification: "已儲存偏好設定。切換前須驗證額度和計費方式。",
    destination: "備用執行方式", destinationDetail: "繼續工作所用的執行方式和模型",
    apiCreditCap: "API 工作限額", creditDetail: "切換至 API 時要求使用的點數上限",
    transfer: "傳輸範圍", transferSummary: "傳送繼續工作所需的摘要", transferChanges: "傳送繼續工作所需的摘要及檔案變更",
    connectSettings: "連線 Code 金鑰以儲存切換設定。", settingsFailed: "無法儲存切換設定。",
    model: "備用模型", unset: "未設定", credits: "點數", on: "開啟", off: "關閉", save: "儲存", review: "查看",
  },
  fr: {
    heading: "Exécution et limites", nextTasks: "Les préférences enregistrées s’appliquent aux nouvelles tâches Code.",
    preference: "Mode d’exécution préféré", description: "Utiliser par défaut l’API ou le CLI d’un fournisseur connecté",
    providerCli: "CLI du fournisseur", cliUnavailable: "Connectez {cli} pour utiliser ce modèle.",
    apiRequired: "Choisissez l’API Tomverse pour utiliser ce modèle.", useApi: "Utiliser l’API Tomverse",
    cliFixture: "{cli} · Test local",
    automatic: "Basculer automatiquement lorsque la limite est atteinte", automaticDetail: "S’applique uniquement après confirmation.",
    awaitingVerification: "Préférence enregistrée. Le basculement exige la vérification des limites et de la facturation.",
    destination: "Mode de secours", destinationDetail: "Mode d’exécution et modèle pour poursuivre la tâche",
    apiCreditCap: "Limite API par tâche", creditDetail: "Plafond de crédits demandé pour le basculement vers l’API",
    transfer: "Portée du transfert", transferSummary: "Envoyer le résumé nécessaire à la poursuite de la tâche",
    transferChanges: "Envoyer le résumé et les modifications de fichiers nécessaires",
    connectSettings: "Connectez une clé Code pour enregistrer les réglages de secours.", settingsFailed: "Impossible d’enregistrer les réglages de secours.",
    model: "Modèle de secours", unset: "Non défini", credits: "crédits", on: "Activé", off: "Désactivé", save: "Enregistrer", review: "Consulter",
  },
  de: {
    heading: "Ausführung und Limits", nextTasks: "Gespeicherte Einstellungen gelten für neue Code-Aufgaben.",
    preference: "Bevorzugte Ausführungsart", description: "Standardmäßig die API oder eine verbundene Anbieter-CLI verwenden",
    providerCli: "Anbieter-CLI", cliUnavailable: "Verbinden Sie {cli}, um dieses Modell zu verwenden.",
    apiRequired: "Wählen Sie Tomverse API, um dieses Modell zu verwenden.", useApi: "Tomverse API verwenden",
    cliFixture: "{cli} · Lokaler Test",
    automatic: "Bei erreichtem Limit automatisch wechseln", automaticDetail: "Gilt nur nach bestätigtem Erreichen des Limits.",
    awaitingVerification: "Einstellung gespeichert. Ein Wechsel erfordert bestätigte Limits und Abrechnung.",
    destination: "Ausweichziel", destinationDetail: "Ausführungsart und Modell zum Fortsetzen der Aufgabe",
    apiCreditCap: "API-Limit pro Aufgabe", creditDetail: "Angefordertes Kreditlimit für den Wechsel zur API",
    transfer: "Umfang der Übertragung", transferSummary: "Nötige Zusammenfassung der Aufgabe senden",
    transferChanges: "Nötige Zusammenfassung und Dateiänderungen senden",
    connectSettings: "Verbinde einen Code-Schlüssel, um Ausweicheinstellungen zu speichern.", settingsFailed: "Ausweicheinstellungen konnten nicht gespeichert werden.",
    model: "Ausweichmodell", unset: "Nicht festgelegt", credits: "Credits", on: "An", off: "Aus", save: "Speichern", review: "Prüfen",
  },
  es: {
    heading: "Ejecución y límites", nextTasks: "Las preferencias guardadas se aplican a las nuevas tareas de Code.",
    preference: "Modo de ejecución preferido", description: "Usar la API o una CLI de proveedor conectada de forma predeterminada",
    providerCli: "CLI del proveedor", cliUnavailable: "Conecta {cli} para usar este modelo.",
    apiRequired: "Selecciona Tomverse API para usar este modelo.", useApi: "Usar Tomverse API",
    cliFixture: "{cli} · Prueba local",
    automatic: "Cambiar automáticamente al alcanzar el límite", automaticDetail: "Solo se aplica cuando se confirma que se agotó el límite.",
    awaitingVerification: "Preferencia guardada. Para cambiar se deben verificar los límites y la facturación.",
    destination: "Destino alternativo", destinationDetail: "Modo de ejecución y modelo para continuar la tarea",
    apiCreditCap: "Límite de API por tarea", creditDetail: "Límite de créditos solicitado para el cambio a la API",
    transfer: "Alcance de la transferencia", transferSummary: "Enviar el resumen necesario para continuar la tarea",
    transferChanges: "Enviar el resumen y los cambios de archivos necesarios",
    connectSettings: "Conecta una clave de Code para guardar la configuración alternativa.", settingsFailed: "No se pudo guardar la configuración alternativa.",
    model: "Modelo alternativo", unset: "Sin configurar", credits: "créditos", on: "Activado", off: "Desactivado", save: "Guardar", review: "Revisar",
  },
  pt: {
    heading: "Execução e limites", nextTasks: "As preferências guardadas aplicam-se às novas tarefas do Code.",
    preference: "Modo de execução preferido", description: "Usar por predefinição a API ou uma CLI de fornecedor ligada",
    providerCli: "CLI do fornecedor", cliUnavailable: "Ligue {cli} para usar este modelo.",
    apiRequired: "Selecione Tomverse API para usar este modelo.", useApi: "Usar Tomverse API",
    cliFixture: "{cli} · Teste local",
    automatic: "Mudar automaticamente ao atingir o limite", automaticDetail: "Aplica-se apenas após confirmar que o limite se esgotou.",
    awaitingVerification: "Preferência guardada. A mudança exige a verificação dos limites e da faturação.",
    destination: "Destino alternativo", destinationDetail: "Modo de execução e modelo para continuar a tarefa",
    apiCreditCap: "Limite de API por tarefa", creditDetail: "Limite de créditos pedido para a mudança para a API",
    transfer: "Âmbito da transferência", transferSummary: "Enviar o resumo necessário para continuar a tarefa",
    transferChanges: "Enviar o resumo e as alterações de ficheiros necessários",
    connectSettings: "Ligue uma chave Code para guardar as definições de alternativa.", settingsFailed: "Não foi possível guardar as definições de alternativa.",
    model: "Modelo alternativo", unset: "Por definir", credits: "créditos", on: "Ativado", off: "Desativado", save: "Guardar", review: "Rever",
  },
} satisfies Record<Language, Copy>;
