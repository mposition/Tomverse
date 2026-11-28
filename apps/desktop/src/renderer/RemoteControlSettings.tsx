import { useEffect, useState } from "react";
import type { Language } from "../../../../lib/language";
import { desktopRemoteCopy } from "../../../../locales/desktopRemote";
import type { RemoteControlCommand, RemoteControlView } from "../remote-control-contract";

/**
 * Settings > Execution and limits: control of this PC from the account's other devices. Off by default; turning it on
 * asks in a native dialog. The text says exactly what is sent and what is answered only here.
 */
export function RemoteControlSettings({ language }: { language: Language }) {
  const copy = desktopRemoteCopy[language];
  const [view, setView] = useState<RemoteControlView | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(command: RemoteControlCommand) {
    setBusy(true);
    try { setView(await window.desktop.remoteControl(command)); }
    catch { /* The view keeps what it last read. */ }
    finally { setBusy(false); }
  }
  useEffect(() => {
    let current = true;
    const read = () => window.desktop.remoteControl({ action: "read" }).then((loaded) => { if (current) setView(loaded); }, () => undefined);
    void read();
    // The state line (connected, nothing running, unavailable) follows the main process while the screen is open.
    const timer = setInterval(read, 5_000);
    return () => { current = false; clearInterval(timer); };
  }, []);

  const status = view ? ({
    signed_out: copy.statusSignedOut, off: "", idle: copy.statusIdle, connected: copy.statusConnected,
    unavailable: copy.statusUnavailable, error: copy.statusError,
  })[view.status] : "";
  return <div className="execution-setting-row" data-testid="remote-control-setting">
    <div>
      <label htmlFor="remote-control">{copy.settingLabel}</label>
      <small id="remote-control-info">{copy.settingDetail}</small>
      <small data-testid="remote-control-sent">{copy.sentToServer}</small>
      <small data-testid="remote-control-pc-only">{copy.pcOnlyNote}</small>
      {view?.enabled && view.page && <small data-testid="remote-control-page">{copy.openOn.replace("{page}", () => view.page!)}</small>}
      {view?.enabled && view.preview.available && <>
        <label htmlFor="remote-control-preview">{copy.previewLabel}</label>
        <small id="remote-control-preview-info" data-testid="remote-control-preview-detail">{copy.previewDetail}</small>
      </>}
      {status && <small role="status" data-testid="remote-control-status" data-status={view?.status}>{status}</small>}
    </div>
    <div className="execution-setting-control">
      <select id="remote-control" aria-describedby="remote-control-info" value={view?.enabled ? "on" : "off"}
        disabled={!view || busy || view.status === "signed_out"} onChange={(event) => {
          void run({ action: "set", enabled: event.currentTarget.value === "on" });
        }}>
        <option value="off">{copy.settingOff}</option><option value="on">{copy.settingOn}</option>
      </select>
      {view?.enabled && view.preview.available && <select id="remote-control-preview" aria-describedby="remote-control-preview-info" data-testid="remote-control-preview"
        value={view.preview.enabled ? "on" : "off"} disabled={busy} onChange={(event) => {
          void run({ action: "setPreview", enabled: event.currentTarget.value === "on" });
        }}>
        <option value="off">{copy.settingOff}</option><option value="on">{copy.settingOn}</option>
      </select>}
    </div>
  </div>;
}
