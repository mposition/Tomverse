import type { Language } from "../lib/language";

type Copy = {
  heading: string; intro: string; label: string; save: string; saving: string; remove: string;
  savedDevice: string; savedSession: string; needsClaude: string; invalid: string; failed: string;
};

/** Settings > Development CLIs: the key for Claude Code on the person's Z.ai Coding Plan. */
export const desktopZaiKeyCopy = {
  en: {
    heading: "Claude Code (Z.ai)",
    intro: "Runs your saved Claude Code on your Z.ai Coding Plan, in a settings folder of its own. Your Claude sign-in is not used or changed, and no Tomverse credits are used.",
    label: "Z.ai API key", save: "Save key", saving: "Saving…", remove: "Remove key",
    savedDevice: "Key saved on this device, encrypted.", savedSession: "Key kept for this session only: this device cannot encrypt it.",
    needsClaude: "Set up Claude Code above first.", invalid: "Enter the API key from your Z.ai account.", failed: "The key could not be saved. Try again.",
  },
  ko: {
    heading: "Claude Code (Z.ai)",
    intro: "저장된 Claude Code를 Z.ai Coding Plan으로 실행합니다. 설정 폴더는 따로 씁니다. Claude 로그인은 쓰지도 바꾸지도 않으며, Tomverse 크레딧도 쓰지 않습니다.",
    label: "Z.ai API 키", save: "키 저장", saving: "저장 중…", remove: "키 삭제",
    savedDevice: "키가 이 기기에 암호화되어 저장되었습니다.", savedSession: "이 기기에서는 암호화할 수 없어 이번 세션에만 키를 보관합니다.",
    needsClaude: "먼저 위에서 Claude Code를 설정하세요.", invalid: "Z.ai 계정의 API 키를 입력하세요.", failed: "키를 저장하지 못했습니다. 다시 시도하세요.",
  },
  zh: {
    heading: "Claude Code (Z.ai)",
    intro: "使用你的 Z.ai Coding Plan 运行已保存的 Claude Code，并使用单独的设置文件夹。不会使用或更改你的 Claude 登录，也不会使用 Tomverse 积分。",
    label: "Z.ai API 密钥", save: "保存密钥", saving: "正在保存…", remove: "删除密钥",
    savedDevice: "密钥已加密保存在此设备上。", savedSession: "此设备无法加密密钥，仅在本次会话中保留。",
    needsClaude: "请先在上方设置 Claude Code。", invalid: "请输入你的 Z.ai 账户中的 API 密钥。", failed: "无法保存密钥，请重试。",
  },
  "zh-Hant": {
    heading: "Claude Code (Z.ai)",
    intro: "使用你的 Z.ai Coding Plan 執行已儲存的 Claude Code，並使用獨立的設定資料夾。不會使用或變更你的 Claude 登入，也不會使用 Tomverse 點數。",
    label: "Z.ai API 金鑰", save: "儲存金鑰", saving: "正在儲存…", remove: "刪除金鑰",
    savedDevice: "金鑰已加密儲存在此裝置上。", savedSession: "此裝置無法加密金鑰，僅在本次工作階段中保留。",
    needsClaude: "請先在上方設定 Claude Code。", invalid: "請輸入你的 Z.ai 帳戶中的 API 金鑰。", failed: "無法儲存金鑰，請再試一次。",
  },
  fr: {
    heading: "Claude Code (Z.ai)",
    intro: "Exécute votre Claude Code enregistré avec votre Z.ai Coding Plan, dans un dossier de réglages distinct. Votre connexion Claude n'est ni utilisée ni modifiée, et aucun crédit Tomverse n'est utilisé.",
    label: "Clé API Z.ai", save: "Enregistrer la clé", saving: "Enregistrement…", remove: "Supprimer la clé",
    savedDevice: "Clé enregistrée sur cet appareil, chiffrée.", savedSession: "Clé conservée pour cette session uniquement : cet appareil ne peut pas la chiffrer.",
    needsClaude: "Configurez d'abord Claude Code ci-dessus.", invalid: "Saisissez la clé API de votre compte Z.ai.", failed: "La clé n'a pas pu être enregistrée. Réessayez.",
  },
  de: {
    heading: "Claude Code (Z.ai)",
    intro: "Führt Ihr gespeichertes Claude Code mit Ihrem Z.ai Coding Plan aus, in einem eigenen Einstellungsordner. Ihre Claude-Anmeldung wird weder verwendet noch geändert, und es werden keine Tomverse-Credits verwendet.",
    label: "Z.ai-API-Schlüssel", save: "Schlüssel speichern", saving: "Wird gespeichert…", remove: "Schlüssel entfernen",
    savedDevice: "Schlüssel verschlüsselt auf diesem Gerät gespeichert.", savedSession: "Schlüssel nur für diese Sitzung behalten: Dieses Gerät kann ihn nicht verschlüsseln.",
    needsClaude: "Richten Sie zuerst oben Claude Code ein.", invalid: "Geben Sie den API-Schlüssel Ihres Z.ai-Kontos ein.", failed: "Der Schlüssel konnte nicht gespeichert werden. Versuchen Sie es erneut.",
  },
  es: {
    heading: "Claude Code (Z.ai)",
    intro: "Ejecuta tu Claude Code guardado con tu Z.ai Coding Plan, en una carpeta de ajustes propia. Tu inicio de sesión de Claude no se usa ni se cambia, y no se usan créditos de Tomverse.",
    label: "Clave de API de Z.ai", save: "Guardar clave", saving: "Guardando…", remove: "Quitar clave",
    savedDevice: "Clave guardada en este dispositivo, cifrada.", savedSession: "Clave guardada solo para esta sesión: este dispositivo no puede cifrarla.",
    needsClaude: "Configura primero Claude Code arriba.", invalid: "Introduce la clave de API de tu cuenta de Z.ai.", failed: "No se pudo guardar la clave. Inténtalo de nuevo.",
  },
  pt: {
    heading: "Claude Code (Z.ai)",
    intro: "Executa o Claude Code guardado com o seu Z.ai Coding Plan, numa pasta de definições própria. O seu início de sessão do Claude não é usado nem alterado, e não são usados créditos Tomverse.",
    label: "Chave de API da Z.ai", save: "Guardar chave", saving: "A guardar…", remove: "Remover chave",
    savedDevice: "Chave guardada neste dispositivo, cifrada.", savedSession: "Chave mantida apenas nesta sessão: este dispositivo não a consegue cifrar.",
    needsClaude: "Configure primeiro o Claude Code acima.", invalid: "Introduza a chave de API da sua conta Z.ai.", failed: "Não foi possível guardar a chave. Tente novamente.",
  },
} satisfies Record<Language, Copy>;
