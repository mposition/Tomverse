import { useEffect, useState, type ReactNode } from "react";
import type { Language } from "../../../../lib/language";
import { en } from "../../../../locales/en";
import { ko } from "../../../../locales/ko";
import { zh } from "../../../../locales/zh";
import { zhHant } from "../../../../locales/zhHant";
import { fr } from "../../../../locales/fr";
import { de } from "../../../../locales/de";
import { es } from "../../../../locales/es";
import { pt } from "../../../../locales/pt";
import { desktopShellCopy } from "../../../../locales/desktopShell";
import { desktopControlsCopy } from "../../../../locales/desktopControls";

// Pieces every Desktop settings panel shares: the web dictionaries, the labelled row,
// and the read/retry and action-failure states.
export const dictionaries = { en, ko, zh, "zh-Hant": zhHant, fr, de, es, pt };
export const languageLabel = (language: Language) => new Intl.DisplayNames(language, { type: "language" }).of(language) ?? language;

export function AccountSettingRow({ label, children, description }: {
  label: ReactNode; children: ReactNode; description?: ReactNode;
}) {
  return <div className="execution-setting-row account-setting-row">
    <div>{label}{description && <small>{description}</small>}</div>
    <div className="account-setting-control">{children}</div>
  </div>;
}

export function useSettingsRead<Data>(load: () => Promise<Data>) {
  const [state, setState] = useState<{ load: typeof load; attempt: number; data?: Data; failed?: true }>();
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let current = true;
    void load().then(
      data => { if (current) setState({ load, attempt, data }); },
      () => { if (current) setState({ load, attempt, failed: true }); },
    );
    return () => { current = false; };
  }, [load, attempt]);
  const visible = state?.load === load && state.attempt === attempt ? state : undefined;
  return { ...visible, reload: () => setAttempt(value => value + 1), setData: (data: Data) => setState({ load, attempt, data }) };
}

export function ReadStatus({ language, failed, retry }: { language: Language; failed?: boolean; retry(): void }) {
  return failed ? <div className="desktop-settings-feedback">
    <p role="alert">{desktopShellCopy[language].actionFailed}</p>
    <button type="button" className="soft" onClick={retry}>{desktopControlsCopy[language].retrySettings}</button>
  </div> : <p role="status">{dictionaries[language].auth.loading}</p>;
}

export function ActionStatus({ language, failed }: { language: Language; failed: boolean }) {
  return failed ? <p className="notice" role="alert">{desktopShellCopy[language].actionFailed}</p> : null;
}


export type Common = { language: Language };
