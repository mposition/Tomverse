import { useEffect, useRef, useState } from "react";
import { desktopAccountDataCopy } from "../../../../locales/desktopAccountData";
import { desktopShellCopy } from "../../../../locales/desktopShell";
import { DELETE_ALL_MEMORIES_PHRASE } from "../account-data-contract";
import { AccountDataResultLine, TypedConfirmation, useAccountDataAction } from "./AccountDataSettings";
import { AccountSettingRow, dictionaries, useSettingsRead, type Common } from "./settings-shared";

const loadRuns = () => window.desktop.accountSettings<"extractionRuns">({ action: "extractionRuns" });
const loadProjects = () => window.desktop.accountSettings<"projects">({ action: "projects" });

/** Recent memory extraction runs. A server with extraction switched off answers an error: show nothing. */
function ExtractionRuns({ language }: Common) {
  const copy = dictionaries[language].memoryExtraction;
  const words = desktopAccountDataCopy[language];
  const state = useSettingsRead(loadRuns);
  const [armed, setArmed] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const reload = useRef(state.reload);
  useEffect(() => { reload.current = state.reload; });
  const active = !!state.data?.activeRunId;
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => reload.current(), 5_000);
    return () => clearInterval(timer);
  }, [active]);
  if (!state.data) return null;
  const labels: Record<string, string> = copy.status;
  return <section className="desktop-setting-section" data-testid="native-memory-extraction">
    <h3>{copy.runTitle}</h3>
    {state.data.runs.length === 0 ? <p>{words.extractionEmpty}</p> : <ul>
      {state.data.runs.map(run => {
        const open = run.status === "pending" || run.status === "running";
        return <li key={run.id}>
          <strong>{labels[run.status] ?? run.status}</strong>{" "}
          <small>{new Date(run.createdAt).toLocaleString(language)} · {copy.runProgress
            .replace("{completed}", String(run.chunkCompleted)).replace("{total}", String(run.chunkTotal))}</small>
          {open && <button type="button" className="soft" disabled={busy} data-testid="native-memory-extraction-cancel" onClick={() => {
            if (armed !== run.id) { setArmed(run.id); return; }
            setBusy(true); setFailed(false);
            void window.desktop.accountSettings<"cancelExtraction">({ action: "cancelExtraction", id: run.id })
              .catch(() => setFailed(true)).finally(() => { setBusy(false); setArmed(undefined); state.reload(); });
          }}>{armed === run.id ? copy.cancelArmed : copy.cancel}</button>}
        </li>;
      })}
    </ul>}
    {failed && <p className="notice" role="alert">{desktopShellCopy[language].actionFailed}</p>}
  </section>;
}

/** Memory export, delete-all and the extraction status, under the stored-memory list. */
export function MemoryDataActions({ language }: Common) {
  const copy = dictionaries[language].memoryReview;
  const words = desktopAccountDataCopy[language];
  const exporter = useAccountDataAction();
  const eraser = useAccountDataAction();
  const [confirming, setConfirming] = useState(false);
  const phrase = language === "ko" ? copy.deleteAllTitle : DELETE_ALL_MEMORIES_PHRASE;
  return <>
    <ExtractionRuns language={language} />
    <section className="desktop-setting-section" data-testid="native-memory-export">
      <h3>{copy.exportTitle}</h3>
      <p>{copy.exportDescription}</p>
      <button type="button" className="soft" disabled={exporter.busy} data-testid="native-memory-export-save"
        onClick={() => void exporter.run({ action: "saveMemories" })}>{exporter.busy ? words.working : copy.exportDownload}</button>
      {exporter.result?.status === "saved" && <p role="status">{words.saved}</p>}
      <AccountDataResultLine language={language} status={exporter.result?.status} />
    </section>
    <section className="desktop-setting-section" data-testid="native-memory-delete-all">
      <h3>{copy.deleteAllTitle}</h3>
      <p>{copy.deleteAllDescription}</p>
      <p>{copy.deleteAllImportsNote}</p>
      {eraser.result?.status === "deleted" ? <p role="status">{copy.deleteAllDone}</p> : confirming ? <TypedConfirmation
        language={language} testId="native-memory-delete-all-form" phrase={phrase} prompt={copy.deleteAllConfirmLabel}
        actionLabel={copy.deleteAllSubmit} busy={eraser.busy}
        onCancel={() => { setConfirming(false); eraser.clear(); }}
        onConfirm={() => void eraser.run({ action: "deleteAllMemories", confirmation: DELETE_ALL_MEMORIES_PHRASE })} />
        : <button type="button" className="soft" onClick={() => setConfirming(true)}>{copy.deleteAllSubmit}</button>}
      <AccountDataResultLine language={language} status={eraser.result?.status} />
    </section>
  </>;
}

/** Moves one memory between personal use and a project. */
export function MemoryScope({ language, id, revision, projectId, onMoved }: Common & {
  id: string; revision: number; projectId: string | null; onMoved(): void;
}) {
  const words = desktopAccountDataCopy[language];
  const state = useSettingsRead(loadProjects);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  if (!state.data) return null;
  return <AccountSettingRow label={<label htmlFor={"memory-scope-" + id}>{words.scopeLabel}</label>}>
    <select id={"memory-scope-" + id} value={projectId ?? ""} disabled={busy} data-testid="native-memory-scope"
      onChange={event => {
        const target = event.currentTarget.value || null;
        setBusy(true); setFailed(false);
        void window.desktop.accountSettings<"moveMemoryScope">({ action: "moveMemoryScope", id, expectedRevision: revision, projectId: target })
          .then(onMoved, () => setFailed(true)).finally(() => setBusy(false));
      }}>
      <option value="">{words.scopeAll}</option>
      {state.data.projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
      {projectId && !state.data.projects.some(project => project.id === projectId) && <option value={projectId}>{projectId}</option>}
    </select>
    {failed && <span role="alert">{desktopShellCopy[language].actionFailed}</span>}
  </AccountSettingRow>;
}

/** Deletes one memory after a second press, as the web does. */
export function DeleteMemory({ language, id, onDeleted }: Common & { id: string; onDeleted(): void }) {
  const copy = dictionaries[language].memoryReview;
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  return <>
    <button type="button" className="soft" disabled={busy} data-testid="native-memory-delete" onClick={() => {
      if (!armed) { setArmed(true); return; }
      setBusy(true); setFailed(false);
      void window.desktop.accountSettings<"deleteMemory">({ action: "deleteMemory", id })
        .then(onDeleted, () => { setFailed(true); setArmed(false); }).finally(() => setBusy(false));
    }}>{armed ? copy.deleteArmed : copy.delete}</button>
    {failed && <p role="alert">{desktopShellCopy[language].actionFailed}</p>}
  </>;
}
