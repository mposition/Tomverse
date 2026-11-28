import { ACCOUNT_SETTINGS_TABS, type AccountSettingsTab } from "../lib/accountSettingsEvents";
import type { Language } from "../lib/language";

const fields = [...ACCOUNT_SETTINGS_TABS, "permissions"] as const;
type Labels<Fields extends readonly string[]> = { [Index in keyof Fields]: string };
const labels = {
  en: ["Account", "Preferences", "AI assistants", "AI personalization", "Data", "Developer", "Plan", "Task permissions"],
  ko: ["계정", "환경설정", "AI 어시스턴트", "AI 개인화", "데이터", "개발자", "플랜", "작업 권한"],
  zh: ["账号", "偏好设置", "AI 助手", "AI 个性化", "数据", "开发者", "方案", "任务权限"],
  "zh-Hant": ["帳號", "偏好設定", "AI 助理", "AI 個人化", "資料", "開發者", "方案", "工作權限"],
  fr: ["Compte", "Préférences", "Assistants IA", "Personnalisation de l’IA", "Données", "Développeur", "Abonnement", "Autorisations des tâches"],
  de: ["Konto", "Einstellungen", "KI-Assistenten", "KI-Personalisierung", "Daten", "Entwickler", "Tarif", "Aufgabenberechtigungen"],
  es: ["Cuenta", "Preferencias", "Asistentes de IA", "Personalización de la IA", "Datos", "Desarrollador", "Plan", "Permisos de tareas"],
  pt: ["Conta", "Preferências", "Assistentes de IA", "Personalização da IA", "Dados", "Desenvolvedor", "Plano", "Permissões de tarefas"],
} satisfies Record<Language, Labels<typeof fields>>;

export const desktopSettingsCopy = (language: Language) => Object.fromEntries(
  fields.map((field, index) => [field, labels[language][index]]),
) as Record<AccountSettingsTab | "permissions", string>;
