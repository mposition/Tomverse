import { useEffect, useState } from "react";
import type { Language } from "../../../../lib/language";
import { desktopCodeSandboxCopy } from "../../../../locales/desktopCodeSandbox";
import { codeSandboxMode, type CodeSandboxEnforcement, type CodeSandboxInput, type CodeSandboxMode, type CodeSandboxView } from "../code-sandbox-contract";
import "./code-sandbox.css";

type Copy = (typeof desktopCodeSandboxCopy)[Language];

const reasonText = (copy: Copy, reason: NonNullable<CodeSandboxEnforcement["unavailable"]>) => ({
  "unsupported-platform": copy.reasonUnsupported,
  "missing-sandbox-exec": copy.reasonSandboxExec,
  "sandbox-exec-failed": copy.reasonSandboxExec,
  "missing-bwrap": copy.reasonBwrap,
  "bwrap-failed": copy.reasonBwrapFailed,
  "workspace-too-broad": copy.reasonTooBroad,
  "windows-launcher-failed": copy.reasonLauncher,
  "windows-workspace-not-markable": copy.reasonNotMarkable,
  "proxy-failed": copy.reasonProxy,
})[reason];

/** The three things the sandbox can enforce, each with what this computer really does about it. */
function Enforcement({ copy, view }: { copy: Copy; view: CodeSandboxView }) {
  const { enforcement } = view;
  const rows = enforcement.available ? [
    ["writes", copy.writesLabel, enforcement.writes === "os" ? copy.writesOs : copy.writesNone],
    ["reads", copy.readsLabel, enforcement.credentialReads === "os" ? copy.readsOs : enforcement.credentialReads === "partial" ? copy.readsPartial : copy.readsNone],
    ["network", copy.networkLabel, ({ "os-proxy-only": copy.netProxy, "os-blocked": copy.netBlocked, "environment-only": copy.netEnv, none: copy.netNone })[enforcement.network]],
  ] as const : [];
  return <div className="sandbox-enforcement" data-testid="sandbox-enforcement" data-platform={view.platform}>
    <h3>{view.preview ? copy.enforcementPreview : copy.enforcementNow}</h3>
    {enforcement.available ? <dl>{rows.map(([key, label, text]) => <div key={key} data-testid={`sandbox-enforcement-${key}`}>
      <dt>{label}</dt><dd>{text}</dd>
    </div>)}</dl> : <p role="alert" data-testid="sandbox-unavailable">
      {copy.unavailable} {enforcement.unavailable ? reasonText(copy, enforcement.unavailable) : ""}
    </p>}
  </div>;
}

/** Desktop > Execution and limits > Command sandbox: the mode, what the computer enforces for it, and the sites a command may reach. */
export function CodeSandboxSettings({ language }: { language: Language }) {
  const copy = desktopCodeSandboxCopy[language];
  const [view, setView] = useState<CodeSandboxView | null>(null);
  const [failed, setFailed] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(input: CodeSandboxInput) {
    setBusy(true);
    try {
      setView(await window.desktop.codeSandbox(input));
      setFailed(false);
      return true;
    } catch {
      setFailed(true);
      return false;
    } finally { setBusy(false); }
  }
  useEffect(() => {
    let current = true;
    window.desktop.codeSandbox({ action: "read" }).then((loaded) => { if (current) setView(loaded); }, () => { if (current) setFailed(true); });
    return () => { current = false; };
  }, []);

  const labels: Record<CodeSandboxMode, string> = { off: copy.modeOff, "workspace-write": copy.modeWorkspace, "read-only": copy.modeReadOnly };
  const text = draft ?? view?.domains.join("\n") ?? "";
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const dirty = !!view && draft !== null && draft !== view.domains.join("\n");
  async function saveDomains(domains: string[]) {
    if (await run({ action: "set-domains", domains })) setDraft(null);
  }

  return <section className="sandbox-settings" aria-labelledby="code-sandbox-heading" data-testid="code-sandbox">
    <h3 id="code-sandbox-heading">{copy.heading}</h3>
    <p>{copy.detail}</p>
    <p data-testid="sandbox-scope">{copy.scope}</p>
    <div className="execution-setting-row">
      <div><label htmlFor="code-sandbox-mode">{copy.mode}</label></div>
      <div className="execution-setting-control">
        <select id="code-sandbox-mode" value={view?.mode ?? "off"} disabled={!view || busy}
          onChange={(event) => {
            const next = codeSandboxMode.safeParse(event.currentTarget.value);
            if (next.success) void run({ action: "set-mode", mode: next.data });
          }}>
          {codeSandboxMode.options.map((value) => <option key={value} value={value}>{labels[value]}</option>)}
        </select>
      </div>
    </div>
    {view && <Enforcement copy={copy} view={view} />}
    <div className="sandbox-block">
      <label htmlFor="code-sandbox-domains">{copy.domains}</label>
      <small id="code-sandbox-domains-info">{copy.domainsDetail}</small>
      <textarea id="code-sandbox-domains" rows={6} spellCheck={false} autoCapitalize="none" aria-describedby="code-sandbox-domains-info"
        value={text} disabled={!view || busy} onChange={(event) => setDraft(event.currentTarget.value)} />
      <div className="sandbox-actions">
        <button className="soft" type="button" disabled={!dirty || busy || lines.length > 200} onClick={() => void saveDomains(lines)}>{copy.domainsSave}</button>
        <button className="soft" type="button" disabled={!view || busy} onClick={() => view && void saveDomains(view.defaultDomains)}>{copy.domainsReset}</button>
      </div>
      {!!view?.ignoredDomains && <p role="status">{copy.domainsIgnored.replace("{count}", String(view.ignoredDomains))}</p>}
    </div>
    <div className="execution-setting-row">
      <div><label htmlFor="code-sandbox-localhost">{copy.localhost}</label><small id="code-sandbox-localhost-info">{copy.localhostDetail}</small></div>
      <div className="execution-setting-control">
        <select id="code-sandbox-localhost" aria-describedby="code-sandbox-localhost-info" value={view?.allowLocalhost ? "on" : "off"} disabled={!view || busy}
          onChange={(event) => void run({ action: "set-localhost", enabled: event.currentTarget.value === "on" })}>
          <option value="off">{copy.off}</option><option value="on">{copy.on}</option>
        </select>
      </div>
    </div>
    {view?.platform === "windows" && <div className="execution-setting-row" data-testid="sandbox-windows-marks">
      <div><span>{copy.windowsMarks}</span><small>{copy.windowsMarksDetail}</small></div>
      <div className="execution-setting-control">
        <span>{view.markedFolders ? copy.windowsMarksCount.replace("{count}", String(view.markedFolders)) : copy.windowsMarksNone}</span>
        <button className="soft" type="button" disabled={busy || !view.markedFolders} onClick={() => void run({ action: "clear-marks" })}>{copy.windowsMarksRemove}</button>
      </div>
    </div>}
    {failed && <p role="alert">{copy.failed}</p>}
  </section>;
}
