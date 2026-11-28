import type { Language } from "../../../../lib/language";
import type { CodePermissionProfile } from "../contract";

const labels: Record<Language, readonly [string, string, string]> = {
  en: ["Project permissions", "Manual", "Accept Edits"],
  ko: ["프로젝트 권한", "수동", "편집 허용"],
  zh: ["项目权限", "手动", "接受编辑"],
  "zh-Hant": ["專案權限", "手動", "接受編輯"],
  fr: ["Autorisations du projet", "Manuel", "Accepter les modifications"],
  de: ["Projektberechtigungen", "Manuell", "Änderungen annehmen"],
  es: ["Permisos del proyecto", "Manual", "Aceptar cambios"],
  pt: ["Permissões do projeto", "Manual", "Aceitar edições"],
};

export function PermissionProfileSelect({ profile, language, disabled, act }: {
  profile: CodePermissionProfile;
  language: Language;
  disabled: boolean;
  act: (operation: () => Promise<unknown>) => Promise<unknown>;
}) {
  const [label, manual, acceptEdits] = labels[language];
  return <select aria-label={label} value={profile} disabled={disabled} onChange={(event) => {
    const next = event.currentTarget.value === "accept_edits" ? "accept_edits" : "manual";
    void act(async () => { if (!await window.desktop.setProjectPermissionProfile(next)) throw new Error("The project changed."); });
  }}>
    <option value="manual">{manual}</option>
    <option value="accept_edits">{acceptEdits}</option>
  </select>;
}
