import { useState } from "react";
import type { Language } from "../../../../lib/language";
import { desktopCodeComputerCopy } from "../../../../locales/desktopCodeComputer";
import { useComputerState } from "./CodeComputer";
import "./code-computer.css";

/** Settings > Execution and limits: the switch for the agent's use of one desktop window. Off by default; turning it on needs the person's confirmation. */
export function CodeComputerSettings({ language }: { language: Language }) {
  const copy = desktopCodeComputerCopy[language];
  const [state, setState] = useComputerState();
  const [confirming, setConfirming] = useState(false);
  const [failed, setFailed] = useState(false);
  async function set(enabled: boolean, confirmed: boolean) {
    try {
      const result = await window.desktop.codeComputer({ type: "enable", enabled, confirmed });
      setState(result.state);
      setFailed(false);
    } catch { setFailed(true); }
    setConfirming(false);
  }
  const supported = state?.supported === true;
  return <div className="execution-setting-row" data-testid="code-computer-setting">
    <div>
      <label htmlFor="code-computer-switch">{copy.settingLabel}</label>
      <small id="code-computer-info">{supported || !state ? copy.settingDetail : copy.unsupported}</small>
    </div>
    <div className="execution-setting-control">
      <select id="code-computer-switch" aria-describedby="code-computer-info" value={state?.enabled ? "on" : "off"} disabled={!supported}
        onChange={(event) => { if (event.currentTarget.value === "on") setConfirming(true); else void set(false, false); }}>
        <option value="off">{copy.settingOff}</option><option value="on">{copy.settingOn}</option>
      </select>
    </div>
    {confirming && <div className="code-computer-confirm" role="alertdialog" aria-labelledby="code-computer-confirm-title" aria-describedby="code-computer-confirm-body">
      <strong id="code-computer-confirm-title">{copy.confirmTitle}</strong>
      <p id="code-computer-confirm-body">{copy.confirmBody}</p>
      <div className="code-computer-actions">
        <button type="button" className="primary" onClick={() => void set(true, true)}>{copy.confirmYes}</button>
        <button type="button" className="soft" onClick={() => setConfirming(false)}>{copy.confirmNo}</button>
      </div>
    </div>}
    {failed && <p role="alert">{copy.failed}</p>}
  </div>;
}
