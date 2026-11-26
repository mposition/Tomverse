import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import type { Language } from "../../../../lib/language";
import { desktopCodeExecutionCopy } from "../../../../locales/desktopCodeExecution";
import { desktopShellCopy } from "../../../../locales/desktopShell";
import { cliProviders, codeExecutionMode, providerClis } from "../code-execution";
import { codeFallbackModelAvailable, codeFallbackUpdate, codeTransferScope, defaultCodeFallbackSettings,
  type CodeFallbackUpdate } from "../code-fallback";
import { codeLimitProfile, type CodeLimitProfile, type CodeMemoryInput, type CodeMemoryView, type Snapshot } from "../contract";
import { desktopCodeEngineCopy } from "../../../../locales/desktopCodeEngine";
import type { CodeEnginePreference } from "./CodeEngine";
import { CodeExtensionsSettings } from "./CodeExtensions";
import { LocalExtensionsPanel } from "./LocalExtensionsPanel";
import { CodeSandboxSettings } from "./CodeSandboxSettings";

type Copy = (typeof desktopCodeExecutionCopy)[Language];
type FallbackEdit = CodeFallbackUpdate extends infer Update ? Update extends CodeFallbackUpdate ? Omit<Update, "scope"> : never : never;

function SettingRow({ label, detail, control, field, status }: { label: string; detail: string; control: ReactNode; field?: string; status?: boolean }) {
  return <div className="execution-setting-row">
    <div>
      {field ? <label htmlFor={field}>{label}</label> : <span>{label}</span>}
      <small id={field ? `${field}-info` : undefined} role={status ? "status" : undefined}>{detail}</small>
    </div>
    <div className="execution-setting-control">{control}</div>
  </div>;
}

function ApiCap({ credits, disabled, copy, save }: { credits: number | null; disabled: boolean; copy: Copy; save: (value: number | null) => void }) {
  const [draft, setDraft] = useState(credits?.toString() ?? "");
  const value = draft === "" ? null : Number(draft);
  const valid = value === null || (/^\d+$/.test(draft) && Number.isSafeInteger(value) && value > 0);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (valid && value !== credits && !disabled) save(value);
  }
  return <form className="execution-cap" onSubmit={submit}>
    <div>
      <input id="code-fallback-credits" type="text" inputMode="numeric" maxLength={16} value={draft} placeholder={copy.unset}
        disabled={disabled} aria-describedby="code-fallback-credits-info" aria-invalid={!valid}
        onChange={(event) => setDraft(event.currentTarget.value)} />
      <span>{copy.credits}</span>
    </div>
    {value !== credits && <button className="soft" type="submit" disabled={disabled || !valid}>{copy.save}</button>}
  </form>;
}

/** The agent's notes about the open project: the switch for keeping them, and a list the person can read and delete from. */
function CodeMemorySettings({ language }: { language: Language }) {
  const copy = desktopCodeEngineCopy[language];
  const [view, setView] = useState<CodeMemoryView | null>(null);
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  async function run(input: CodeMemoryInput) {
    try { setView(await window.desktop.codeMemory(input)); setFailed(false); }
    catch { setFailed(true); }
  }
  useEffect(() => {
    let current = true;
    window.desktop.codeMemory({ action: "read" }).then((loaded) => { if (current) setView(loaded); }, () => { if (current) setFailed(true); });
    return () => { current = false; };
  }, []);
  const entries = view?.entries ?? [];
  return <>
    <SettingRow field="code-memory" label={copy.memory} detail={copy.memoryDetail} control={
      <select id="code-memory" aria-describedby="code-memory-info" value={view?.enabled === false ? "off" : "on"} disabled={!view}
        onChange={(event) => void run({ action: "set-enabled", enabled: event.currentTarget.value === "on" })}>
        <option value="on">{copy.on}</option><option value="off">{copy.off}</option>
      </select>
    } />
    <SettingRow label={copy.memoryNotes} detail={view?.project ? copy.memoryCount.replace("{count}", String(entries.length)) : copy.memoryNoProject} control={
      <button className="soft" type="button" aria-expanded={open} aria-controls="code-memory-notes" disabled={!view?.project}
        onClick={() => setOpen(!open)}>{open ? copy.memoryHide : copy.memoryView}</button>
    } />
    {open && view?.project && <div className="execution-memory" id="code-memory-notes">
      {entries.length ? <>
        <ul>{entries.map((entry) => <li key={entry.id}>
          <span>{entry.text}</span>
          <button className="soft" type="button" aria-label={copy.memoryRemove} title={copy.memoryRemove}
            onClick={() => void run({ action: "remove", id: entry.id })}>{copy.memoryRemove}</button>
        </li>)}</ul>
        <button className="soft" type="button" onClick={() => void run({ action: "clear" })}>{copy.memoryClear}</button>
      </> : <p>{copy.memoryEmpty}</p>}
    </div>}
    {failed && <p role="alert">{copy.memoryFailed}</p>}
  </>;
}

export function CodeExecutionSettings({ snapshot, language, actionFailed, act, engine: taskEngine, changeEngine }: {
  snapshot: Snapshot | null; language: Language; actionFailed: boolean; act: (action: () => Promise<unknown>) => Promise<void>;
  engine: CodeEnginePreference; changeEngine: (value: CodeEnginePreference) => void;
}) {
  const copy = desktopCodeExecutionCopy[language];
  const engineCopy = desktopCodeEngineCopy[language];
  const limitLabels = { standard: engineCopy.limitsStandard, extended: engineCopy.limitsExtended, unlimited: engineCopy.limitsUnlimited } as const satisfies Record<CodeLimitProfile, string>;
  const [reviewScope, setReviewScope] = useState(false);
  const [writing, setWriting] = useState(false);
  const current = snapshot?.codeFallback;
  const settings = current?.settings ?? defaultCodeFallbackSettings;
  const preference = snapshot?.codeExecutionPreference ?? "tomverse_api";
  const destination = settings.destination;
  const apiModels = snapshot?.models ?? [];
  const cliModels = snapshot?.codeFallbackCliModels ?? {};
  const models = destination?.executionMode === "provider_cli" ? cliModels[destination.provider]?.models ?? []
    : apiModels.filter(({ id }) => id !== "smart-adaptive");
  const engine = destination?.executionMode === "provider_cli" ? destination.provider : destination?.executionMode ?? "";
  const canSelectModel = !!destination && destination.executionMode !== preference && models.length > 0;
  const selectedModel = codeFallbackModelAvailable(destination, apiModels, cliModels) ? destination?.model ?? "" : "";
  const destinationDetail = destination && !models.length
    ? destination.executionMode === "provider_cli" ? copy.cliUnavailable.replace("{cli}", providerClis[destination.provider])
      : desktopShellCopy[language].modelsUnavailable
    : copy.destinationDetail;
  const automatic = settings.automaticFrom === preference;
  const canRequestAutomatic = destination?.executionMode !== preference && settings.apiCreditCap !== null &&
    codeFallbackModelAvailable(destination, apiModels, cliModels);

  async function change(update: FallbackEdit) {
    if (!current || writing) return;
    const data = codeFallbackUpdate.safeParse({ ...update, scope: current.scope });
    if (!data.success) return;
    setWriting(true);
    try { await act(() => window.desktop.updateCodeFallback(data.data)); }
    finally { setWriting(false); }
  }
  const disabled = !current || writing;

  return <section className="execution-settings">
    <h2>{copy.heading}</h2>
    <p>{copy.nextTasks}</p>
    {!current && <p role="status">{copy.connectSettings}</p>}
    <SettingRow field="desktop-code-execution" label={copy.preference} detail={copy.description} control={
      <select id="desktop-code-execution" aria-describedby="desktop-code-execution-info" value={preference}
        disabled={!snapshot || writing} onChange={(event) => {
          const next = codeExecutionMode.safeParse(event.currentTarget.value);
          if (next.success) void act(() => window.desktop.setCodeExecutionPreference(next.data));
        }}>
        <option value="tomverse_api">Tomverse API</option>
        <option value="provider_cli">{copy.providerCli}</option>
      </select>
    } />
    <SettingRow field="code-task-limits" label={engineCopy.limits} detail={engineCopy.limitsDetail} control={
      <select id="code-task-limits" aria-describedby="code-task-limits-info" value={taskEngine.limits}
        onChange={(event) => {
          const next = codeLimitProfile.safeParse(event.currentTarget.value);
          if (next.success) changeEngine({ ...taskEngine, limits: next.data });
        }}>
        {codeLimitProfile.options.map((value) => <option key={value} value={value}>{limitLabels[value]}</option>)}
      </select>
    } />
    <SettingRow field="code-goal-mode" label={engineCopy.goal} detail={engineCopy.goalDetail} control={
      <select id="code-goal-mode" aria-describedby="code-goal-mode-info" value={taskEngine.goal ? "on" : "off"}
        onChange={(event) => changeEngine({ ...taskEngine, goal: event.currentTarget.value === "on" })}>
        <option value="off">{engineCopy.off}</option><option value="on">{engineCopy.on}</option>
      </select>
    } />
    <CodeMemorySettings language={language} />
    <CodeExtensionsSettings language={language} />
    <LocalExtensionsPanel language={language} />
    <SettingRow field="code-fallback-automatic" label={copy.automatic} detail={automatic ? copy.awaitingVerification : copy.automaticDetail}
      status={automatic} control={
      <select id="code-fallback-automatic" aria-describedby="code-fallback-automatic-info" value={automatic ? "on" : "off"}
        disabled={disabled || (!automatic && !canRequestAutomatic)}
        onChange={(event) => void change({ field: "automatic", enabled: event.currentTarget.value === "on" })}>
        <option value="off">{copy.off}</option><option value="on">{copy.on}</option>
      </select>
    } />
    <SettingRow field="code-fallback-destination" label={copy.destination} detail={destinationDetail} control={<>
      <select id="code-fallback-destination" aria-describedby="code-fallback-destination-info" value={engine}
        disabled={disabled} onChange={(event) => {
          const selected = codeFallbackUpdate.safeParse({ scope: current?.scope, field: "destination", engine: event.currentTarget.value || null });
          if (selected.success) void change(selected.data);
        }}>
        <option value="">{copy.unset}</option>
        {preference === "provider_cli" || engine === "tomverse_api" ? <option value="tomverse_api" disabled={preference === "tomverse_api"}>
          Tomverse API
        </option> : null}
        {(preference === "tomverse_api" ? cliProviders : cliProviders.filter((id) => id === engine)).map((id) =>
          <option key={id} value={id} disabled={preference === "provider_cli"}>{providerClis[id]}</option>)}
      </select>
      {destination && <select aria-label={copy.model} value={selectedModel} disabled={disabled || !canSelectModel}
        onChange={(event) => void change({ field: "model", model: event.currentTarget.value || null })}>
        <option value="">{copy.model}</option>
        {models.map(({ id, name }) => <option key={id} value={id}>{name || id}</option>)}
      </select>}
    </>} />
    <SettingRow field="code-fallback-credits" label={copy.apiCreditCap} detail={copy.creditDetail} control={
      <ApiCap key={`${current?.scope ?? ""}:${settings.apiCreditCap ?? ""}`} copy={copy} credits={settings.apiCreditCap} disabled={disabled}
        save={(credits) => void change({ field: "apiCreditCap", credits })} />
    } />
    <SettingRow label={copy.transfer} detail={settings.transfer === "summary" ? copy.transferSummary : copy.transferChanges} control={
      <button className="soft" type="button" aria-expanded={reviewScope} aria-controls="code-fallback-transfer"
        disabled={!current} onClick={() => setReviewScope(!reviewScope)}>{copy.review}</button>
    } />
    {reviewScope && current && <fieldset className="execution-transfer" id="code-fallback-transfer" disabled={disabled}>
      <legend>{copy.transfer}</legend>
      {codeTransferScope.options.map((value) => <label key={value}>
        <input type="radio" name="fallback-transfer" checked={settings.transfer === value}
          onChange={() => void change({ field: "transfer", transfer: value })} />
        {value === "summary" ? copy.transferSummary : copy.transferChanges}
      </label>)}
    </fieldset>}
    <CodeSandboxSettings language={language} />
    {actionFailed && <p role="alert">{copy.settingsFailed}</p>}
  </section>;
}
