import { useEffect, useRef, useState } from "react";
import { AppWindow, Columns2, Eye, ListChecks, Square, X } from "lucide-react";
import type { Language } from "../../../../lib/language";
import { desktopParallelCopy } from "../../../../locales/desktopParallel";
import type { CodeWorktreeChoice, Snapshot, StartInput } from "../contract";
import type { LaneRow } from "../parallel-contract";
import { LaneTaskView } from "./LaneTaskView";
import { SchedulePanel } from "./SchedulePanel";
import { fill, kindLabel, rowStatus } from "./parallel-labels";
import "./parallel.css";

/**
 * Everything that runs next to the open task, in one place: the list of running, waiting and finished tasks with a line each, a form to start
 * another one now, two tasks side by side, a task in a window of its own, and the schedules. The list is the main process's; nothing here
 * decides what may run, it only asks.
 */
export function ActivityControl({ snapshot, language, modelId, effort, onVisibilityChange }: {
  snapshot: Snapshot; language: Language; modelId: string | undefined; effort: StartInput["effort"]; onVisibilityChange: (open: boolean) => void;
}) {
  const copy = desktopParallelCopy[language];
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"tasks" | "schedules">("tasks");
  const [observed, setObserved] = useState<string[]>([]);
  const [prompt, setPrompt] = useState("");
  const [mode, setMode] = useState<"agent" | "ask">("agent");
  const [worktree, setWorktree] = useState(true);
  const [starting, setStarting] = useState(false);
  const [notice, setNotice] = useState<{ text: string; alert: boolean } | null>(null);
  const parallel = snapshot.parallel;
  const rows = parallel?.rows ?? [];
  const active = rows.filter((row) => row.state !== "done").length;
  const git = snapshot.codeGitWorkspace;
  const foreground = rows.find((row) => row.kind === "foreground");
  const rowByKey = new Map(rows.map((row) => [row.key, row]));
  const shown = observed.filter((key) => rowByKey.has(key));
  const laneKeys = shown.filter((key) => key !== foreground?.key);
  const laneKeyText = laneKeys.join(",");

  useEffect(() => {
    void window.desktop.parallel({ action: "observe", keys: open ? laneKeyText.split(",").filter(Boolean) : [] }).catch(() => undefined);
  }, [open, laneKeyText]);

  function toggleSplit(key: string) {
    setObserved((current) => current.includes(key) ? current.filter((value) => value !== key) : [...current, key].slice(-2));
  }
  const command = (input: Parameters<typeof window.desktop.parallel>[0]) => { void window.desktop.parallel(input).catch(() => undefined); };

  async function start() {
    if (!modelId) { setNotice({ text: copy.startNeedsModel, alert: true }); return; }
    setStarting(true);
    setNotice(null);
    const workspace: CodeWorktreeChoice | undefined = mode !== "agent" ? undefined
      : worktree && git?.kind === "git" ? { kind: "worktree", id: git.id, base: git.bases[0]! } : { kind: "local" };
    try {
      await window.desktop.startParallel({ prompt, model: modelId, mode, effort, saveHistory: true, ...(workspace ? { workspace } : {}) });
      setPrompt("");
    } catch { setNotice({ text: copy.startFailed, alert: true }); }
    setStarting(false);
  }

  function openTask(row: LaneRow) {
    if (row.kind === "foreground") dialog.current?.close();
    else if (row.taskId && row.state === "done") void window.desktop.openHistory(row.taskId).then(() => dialog.current?.close(), () => undefined);
    else toggleSplit(row.key);
  }

  return <>
    <button className="icon activity-icon" type="button" aria-label={copy.activityButton} title={copy.activityButton} data-testid="activity-button"
      onClick={() => { dialog.current?.showModal(); setOpen(true); onVisibilityChange(true); }}>
      <ListChecks size={18} />{active > 1 && <span className="activity-badge" data-testid="activity-badge">{active}</span>}
    </button>
    <dialog ref={dialog} className="activity-dialog" aria-labelledby="activity-title" data-testid="activity-dialog"
      onClose={() => { setOpen(false); onVisibilityChange(false); }}>
      {open && <>
        <header>
          <h2 id="activity-title">{copy.activityTitle}</h2>
          <span className="activity-tabs" role="tablist">
            <button type="button" role="tab" className="soft" aria-selected={tab === "tasks"} onClick={() => setTab("tasks")}>{copy.tabTasks}</button>
            <button type="button" role="tab" className="soft" aria-selected={tab === "schedules"} data-testid="tab-schedules" onClick={() => setTab("schedules")}>{copy.tabSchedules}</button>
          </span>
          <button type="button" className="icon" aria-label={copy.close} onClick={() => dialog.current?.close()}><X size={17} /></button>
        </header>
        {tab === "tasks" ? <>
          <div className="activity-limit">
            <label>{copy.limitLabel}{" "}
              <select aria-label={copy.limitLabel} value={parallel?.limit ?? 3} onChange={(event) => command({ action: "set-limit", limit: Number(event.currentTarget.value) })}>
                {Array.from({ length: parallel?.maximum ?? 6 }, (_, index) => index + 1).map((value) => <option key={value} value={value}>{value}</option>)}
              </select></label>
            <small>{copy.limitHint}</small>
          </div>
          {!rows.length ? <p className="activity-hint" data-testid="activity-empty">{copy.empty}</p> : <ul className="activity-list" data-testid="activity-list">
            {rows.map((row) => <li key={row.key} className="activity-row" data-testid="activity-row" data-key={row.key} data-kind={row.kind} data-state={row.state}>
              <div>
                <span className="row-title">{row.title}</span>
                <small>{kindLabel(copy, row.kind)} · <span data-testid="row-status">{rowStatus(copy, row)}</span>
                  {row.isolated ? ` · ${copy.worktree}` : ""}{row.changes ? ` · ${fill(copy.changedFiles, { count: row.changes })}` : ""}</small>
                <small><code>{row.folder}</code></small>
                {row.detail && <span className="row-detail">{row.detail}</span>}
                {row.unattendedApproval && <small role="note" data-testid="unattended-note">{copy.unattendedNote}</small>}
              </div>
              <span className="row-actions">
                {row.unattendedApproval && <button type="button" className="soft" data-testid="review-request" onClick={() => command({ action: "review-approval", key: row.key })}><Eye size={13} /> {copy.reviewRequest}</button>}
                <button type="button" className="soft" data-testid="row-open" onClick={() => openTask(row)}>{row.state === "done" && row.taskId ? copy.openTask : copy.viewTask}</button>
                <button type="button" className="soft" aria-pressed={shown.includes(row.key)} data-testid="row-split" onClick={() => toggleSplit(row.key)}>
                  <Columns2 size={13} /> {shown.includes(row.key) ? copy.splitRemove : copy.splitAdd}</button>
                {row.kind !== "foreground" && <button type="button" className="soft" data-testid="row-window" onClick={() => command({ action: "detach", key: row.key })}><AppWindow size={13} /> {copy.ownWindow}</button>}
                {row.canStop && <button type="button" className="soft" data-testid="row-stop" onClick={() => command({ action: "stop", key: row.key })}><Square size={13} /> {copy.stop}</button>}
                {row.state === "done" && row.kind !== "foreground" && <button type="button" className="soft" onClick={() => command({ action: "dismiss", key: row.key })}>{copy.remove}</button>}
              </span>
            </li>)}
          </ul>}
          <section aria-label={copy.splitHeading}>
            <h3>{copy.splitHeading}</h3>
            {!shown.length ? <p className="activity-hint">{copy.splitEmpty}</p> : <div className="split-panes" data-testid="split-panes">
              {shown.map((key) => {
                const row = rowByKey.get(key) ?? null;
                const task = key === foreground?.key ? snapshot.task : parallel?.tasks[key] ?? null;
                return <LaneTaskView key={key} task={task} row={row} language={language} onStop={() => command({ action: "stop", key })} />;
              })}
            </div>}
          </section>
          <form className="activity-start" data-testid="activity-start" onSubmit={(event) => { event.preventDefault(); if (prompt.trim() && !starting) void start(); }}>
            <h3>{copy.startHeading}</h3>
            <label>{copy.startPrompt}<textarea value={prompt} maxLength={24000} onChange={(event) => setPrompt(event.currentTarget.value)} /></label>
            <div className="activity-limit">
              <label>{copy.startMode}{" "}<select aria-label={copy.startMode} value={mode} onChange={(event) => setMode(event.currentTarget.value as "agent" | "ask")}>
                <option value="agent">{copy.modeAgent}</option><option value="ask">{copy.modeAsk}</option></select></label>
              {mode === "agent" && git?.kind === "git" && <label className="inline"><input type="checkbox" checked={worktree} onChange={(event) => setWorktree(event.currentTarget.checked)} />{copy.startWorktree}</label>}
              <button type="submit" className="primary" disabled={starting || !prompt.trim() || !snapshot.root} data-testid="start-parallel">{copy.startButton}</button>
            </div>
            {notice && <p className="activity-notice" role={notice.alert ? "alert" : "status"}>{notice.text}</p>}
          </form>
        </> : <SchedulePanel view={snapshot.schedules} language={language} models={snapshot.models} defaultModel={modelId} project={snapshot.root}
          onOpenTask={(id) => { void window.desktop.openHistory(id).then(() => dialog.current?.close(), () => undefined); }} />}
      </>}
    </dialog>
  </>;
}
