import { useEffect, useState } from "react";
import type { Language } from "../../../../lib/language";
import { desktopRemoteCopy } from "../../../../locales/desktopRemote";
import type { RemoteConnectionState, RemoteProjectReply, RemoteRecent, RemoteResult, RemoteSnapshot, RemoteView } from "../remote-contract";
import "./remote-project.css";

type Copy = (typeof desktopRemoteCopy)[Language];

const stateText = (copy: Copy, state: RemoteConnectionState) => (state === "connected" ? copy.connected : state === "lost" ? copy.lost : copy.unknown);

function Result({ copy, result }: { copy: Copy; result: RemoteResult }) {
  return result.ok
    ? <p role="status" data-testid="remote-result" data-ok="true">{copy.testedOk.replace("{folder}", result.folder).replace("{system}", result.system || "POSIX")}</p>
    : <p role="alert" data-testid="remote-result" data-ok="false" data-failure={result.failure}>
      {copy.failures[result.failure]}
      {result.failure !== "invalid-target" && <small> {result.message}</small>}
    </p>;
}

/**
 * The SSH target, the folder on that computer, the connection test and "open as project". The window only names what a person typed;
 * the main process checks every part of it and starts ssh itself. No key, password or passphrase is asked for here.
 */
export function RemoteProjectPanel({ language, withSwitch = false, onChanged }: { language: Language; withSwitch?: boolean; onChanged?: () => void }) {
  const copy = desktopRemoteCopy[language];
  const [view, setView] = useState<RemoteView | null>(null);
  const [destination, setDestination] = useState("");
  const [port, setPort] = useState("");
  const [folder, setFolder] = useState("");
  const [busy, setBusy] = useState<"test" | "open" | "reconnect" | "switch" | null>(null);
  const [result, setResult] = useState<RemoteResult | null>(null);
  const [failed, setFailed] = useState(false);

  async function run(action: "test" | "open" | "reconnect" | "switch", call: () => Promise<RemoteProjectReply>) {
    setBusy(action);
    setResult(null);
    try {
      const reply = await call();
      setView(reply.view);
      setFailed(false);
      if (reply.result) setResult(reply.result);
      if (action === "open" && reply.result?.ok) onChanged?.();
    } catch {
      setFailed(true);
    } finally { setBusy(null); }
  }
  useEffect(() => {
    let current = true;
    window.desktop.remoteProject({ action: "read" }).then((loaded) => { if (current) setView(loaded.view); }, () => { if (current) setFailed(true); });
    return () => { current = false; };
  }, []);

  const target = { destination, ...(port.trim() ? { port: port.trim() } : {}), folder };
  const fill = (recent: RemoteRecent) => { setDestination(recent.destination); setPort(recent.port === undefined ? "" : String(recent.port)); setFolder(recent.folder); setResult(null); };
  const enabled = view?.enabled === true;

  return <section className="remote-settings" aria-labelledby="remote-project-heading" data-testid="remote-project">
    <h3 id="remote-project-heading">{copy.heading}</h3>
    <p>{copy.intro}</p>
    {withSwitch && <div className="execution-setting-row">
      <div><label htmlFor="remote-project-switch">{copy.enable}</label><small id="remote-project-switch-note">{copy.enableNote}</small></div>
      <div className="execution-setting-control">
        <input id="remote-project-switch" data-testid="remote-switch" type="checkbox" role="switch" aria-describedby="remote-project-switch-note" checked={enabled}
          disabled={!view || busy !== null} onChange={(event) => void run("switch", () => window.desktop.remoteProject({ action: "set-enabled", enabled: event.currentTarget.checked }))} />
      </div>
    </div>}
    {!enabled && view && !withSwitch && <p role="note">{copy.turnOn}</p>}
    {enabled && <>
      {!!view?.recent.length && <div className="remote-recent" data-testid="remote-recent">
        <span>{copy.recent}</span>
        {view.recent.map((item) => <button key={`${item.destination}|${item.port ?? ""}|${item.folder}`} className="soft" type="button" onClick={() => fill(item)}>
          {item.destination}{item.port !== undefined ? `:${item.port}` : ""} · {item.folder}
        </button>)}
      </div>}
      <form className="remote-form" onSubmit={(event) => { event.preventDefault(); void run("open", () => window.desktop.remoteProject({ action: "open", target })); }}>
        <label>{copy.target}
          <input data-testid="remote-destination" value={destination} onChange={(event) => setDestination(event.currentTarget.value)} maxLength={300}
            spellCheck={false} autoCapitalize="none" autoComplete="off" aria-describedby="remote-destination-hint" />
          <small id="remote-destination-hint">{copy.targetHint}</small>
        </label>
        <label>{copy.port}
          <input data-testid="remote-port" value={port} onChange={(event) => setPort(event.currentTarget.value)} maxLength={5} inputMode="numeric" autoComplete="off" />
        </label>
        <label>{copy.folder}
          <input data-testid="remote-folder" value={folder} onChange={(event) => setFolder(event.currentTarget.value)} maxLength={1100}
            spellCheck={false} autoCapitalize="none" autoComplete="off" aria-describedby="remote-folder-hint" />
          <small id="remote-folder-hint">{copy.folderHint}</small>
        </label>
        <div className="remote-actions">
          <button className="soft" type="button" data-testid="remote-test" disabled={busy !== null || !destination.trim() || !folder.trim()}
            onClick={() => void run("test", () => window.desktop.remoteProject({ action: "test", target }))}>{busy === "test" ? copy.testing : copy.test}</button>
          <button className="primary" type="submit" data-testid="remote-open" disabled={busy !== null || !destination.trim() || !folder.trim()}>{busy === "open" ? copy.opening : copy.open}</button>
        </div>
      </form>
      {result && <Result copy={copy} result={result} />}
      {view?.current && <div className="remote-current" data-testid="remote-current">
        <span>{copy.remoteProject}: <code>{view.current.label}:{view.current.folder}</code></span>
        <strong data-testid="remote-state" data-state={view.current.state}>{stateText(copy, view.current.state)}</strong>
        <button className="soft" type="button" data-testid="remote-reconnect" disabled={busy !== null}
          onClick={() => void run("reconnect", () => window.desktop.remoteProject({ action: "reconnect" }))}>{copy.reconnect}</button>
        {view.sandboxOutside && <p role="note" data-testid="remote-sandbox-note">{copy.sandboxNote}</p>}
      </div>}
    </>}
    {failed && <p role="alert">{copy.failures.failed}</p>}
  </section>;
}

/** On the Code start screen: a button that opens the remote form where remote projects are on, and says where to turn them on where they are not. */
export function RemoteProjectPicker({ language, disabled }: { language: Language; disabled: boolean }) {
  const copy = desktopRemoteCopy[language];
  const [open, setOpen] = useState(false);
  return <div className="remote-picker">
    <button type="button" className="soft" data-testid="remote-picker-button" disabled={disabled} aria-expanded={open} onClick={() => setOpen(!open)}>{copy.openRemote}</button>
    {open && <RemoteProjectPanel language={language} onChanged={() => setOpen(false)} />}
  </div>;
}

/** Above the composer while a remote project is open: which machine, whether it answers, and what is not offered for it. */
export function RemoteProjectStatus({ language, remote }: { language: Language; remote: RemoteSnapshot }) {
  const copy = desktopRemoteCopy[language];
  const [busy, setBusy] = useState(false);
  return <div className="remote-status" data-testid="remote-status" data-state={remote.state}>
    <span>{copy.remoteProject}: <code>{remote.label}:{remote.folder}</code></span>
    <strong data-testid="remote-state" data-state={remote.state}>{stateText(copy, remote.state)}</strong>
    <button className="soft" type="button" data-testid="remote-reconnect" disabled={busy}
      onClick={() => { setBusy(true); void window.desktop.remoteProject({ action: "reconnect" }).finally(() => setBusy(false)); }}>{copy.reconnect}</button>
    {remote.state === "lost" && <p role="alert" data-testid="remote-lost">{copy.lostBanner.replace("{target}", remote.label)}</p>}
    {remote.sandboxOutside && <p role="note" data-testid="remote-sandbox-note">{copy.sandboxNote}</p>}
    <p role="note" data-testid="remote-hidden-panels">{copy.hiddenPanels}</p>
  </div>;
}

/** On the approval card: the action is on another machine, outside this computer's sandbox. */
export function RemoteApprovalNote({ language, remote }: { language: Language; remote: { target: string; folder: string } }) {
  const copy = desktopRemoteCopy[language];
  return <section aria-label={copy.approvalHeading} data-testid="approval-remote">
    <h2>{copy.approvalHeading}</h2>
    <dl><dt>{copy.remoteProject}</dt><dd><code data-testid="approval-remote-target">{remote.target}</code> <code>{remote.folder}</code></dd></dl>
    <p role="note">{copy.approvalNote.replace("{target}", remote.target)}</p>
  </section>;
}
