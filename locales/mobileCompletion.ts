import type { MobileLanguage } from "./mobile";

const en = {
  sources: "Sources", download: "Save file", saving: "Saving…", downloadFailed: "The file could not be saved. Check your connection and try again.",
  fileFailed: "This file could not be created. Ask for it again.", signIn: "Sign in to create files.",
  offline: "You are offline. Your draft stays on this device until you reconnect.",
  account: "Account and data", export: "Export my data", delete: "Delete my account", confirmation: "Type DELETE MY ACCOUNT to confirm",
  deleteDetail: "Your account will be scheduled for deletion using the existing account deletion process. This signs you out on every device.",
  reauthenticate: "Sign in again before exporting data or deleting your account.", reauthenticateAction: "Sign in again", cancel: "Cancel",
  uncertain: "The result could not be confirmed. Sign in again and check your account before trying again.",
  exportSaved: "Your account data was saved.", deleting: "Scheduling deletion…", busy: "Working…",
  checkAccount: "Check account status", accountChecked: "Your account is active. Review your choice before trying again.",
  accountUnavailable: "Account export and deletion are not available in this app yet. Use account settings on the website.",
  restoreDraft: "Restore offline draft",
  logoutUnconfirmed: "Signed out on this device. Server sign-out could not be confirmed. Check your account on the website before trying again.",
};

const copies: Partial<Record<MobileLanguage, typeof en>> = {
  en,
  ko: { ...en, sources: "출처", download: "파일 저장", saving: "저장 중…", downloadFailed: "파일을 저장하지 못했습니다. 연결을 확인하고 다시 시도해 주세요.", fileFailed: "파일을 만들지 못했습니다. 다시 요청해 주세요.", signIn: "파일을 만들려면 로그인하세요." },
  zh: { ...en, sources: "来源", download: "保存文件", saving: "保存中…", downloadFailed: "无法保存文件，请检查连接后重试。", fileFailed: "无法创建文件，请重新请求。", signIn: "请先登录再创建文件。" },
  "zh-Hant": { ...en, sources: "來源", download: "儲存檔案", saving: "儲存中…", downloadFailed: "無法儲存檔案，請檢查連線後再試一次。", fileFailed: "無法建立檔案，請重新提出要求。", signIn: "請先登入再建立檔案。" },
  de: { ...en, sources: "Quellen", download: "Datei speichern", saving: "Wird gespeichert…", downloadFailed: "Die Datei konnte nicht gespeichert werden. Prüfe deine Verbindung und versuche es erneut.", fileFailed: "Die Datei konnte nicht erstellt werden. Frage erneut danach.", signIn: "Melde dich an, um Dateien zu erstellen." },
  fr: { ...en, sources: "Sources", download: "Enregistrer le fichier", saving: "Enregistrement…", downloadFailed: "Le fichier n’a pas pu être enregistré. Vérifiez votre connexion et réessayez.", fileFailed: "Le fichier n’a pas pu être créé. Demandez-le à nouveau.", signIn: "Connectez-vous pour créer des fichiers." },
  es: { ...en, sources: "Fuentes", download: "Guardar archivo", saving: "Guardando…", downloadFailed: "No se pudo guardar el archivo. Comprueba tu conexión e inténtalo de nuevo.", fileFailed: "No se pudo crear el archivo. Vuelve a solicitarlo.", signIn: "Inicia sesión para crear archivos." },
  pt: { ...en, sources: "Fontes", download: "Guardar ficheiro", saving: "A guardar…", downloadFailed: "Não foi possível guardar o ficheiro. Verifique a ligação e tente novamente.", fileFailed: "Não foi possível criar o ficheiro. Volte a pedi-lo.", signIn: "Inicie sessão para criar ficheiros." },
};
export const mobileCompletionCopy = (language: string) => copies[language as MobileLanguage] ?? en;
