import { useEffect, useMemo, useState } from "react";
import { Pencil, Play, Trash2 } from "lucide-react";
import type { Language } from "../../../../lib/language";
import { desktopParallelCopy } from "../../../../locales/desktopParallel";
import type { Model } from "../contract";
import type { ScheduleInput, ScheduleItem, ScheduleRun, ScheduleView } from "../parallel-contract";
import { MINUTE, wallClock, zonedInstant } from "../schedule-core";
import { fill, refusalText, runStatus, timeText } from "./parallel-labels";
import "./parallel.css";

type Preset = "readOnly" | "ask" | "review" | "all";
type Repeat = ScheduleInput["timing"]["cadence"]["kind"];
const presets: Record<Preset, Pick<ScheduleInput, "taskMode" | "permission">> = {
  readOnly: { taskMode: "ask", permission: "read_only" },
  ask: { taskMode: "agent", permission: "ask" },
  review: { taskMode: "agent", permission: "auto_review" },
  all: { taskMode: "agent", permission: "allow_all" },
};
const REQUESTS = { standard: 20, extended: 200 } as const;
const localZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; } };
const pad = (value: number) => String(value).padStart(2, "0");

function presetOf(item: Pick<ScheduleItem, "taskMode" | "permission">): Preset {
  return item.taskMode === "ask" ? "readOnly" : item.permission === "allow_all" ? "all" : item.permission === "auto_review" ? "review" : "ask";
}

function inputValue(instant: number, timeZone: string) {
  const wall = wallClock(instant, timeZone);
  return `${wall.year}-${pad(wall.month)}-${pad(wall.day)}T${pad(wall.hour)}:${pad(wall.minute)}:${pad(wall.second)}`;
}

function describe(copy: (typeof desktopParallelCopy)["en"], item: ScheduleItem, language: Language) {
  const rule = item.timing.cadence;
  const days = (list: number[]) => list.slice().sort().map((day) =>
    new Intl.DateTimeFormat(language, { weekday: "short", timeZone: "UTC" }).format(new Date(Date.UTC(2023, 0, 1 + day)))).join(", ");
  const when = rule.kind === "once" ? `${copy.repeatOnce}: ${timeText(rule.at, language, item.timing.timeZone)}`
    : rule.kind === "interval" ? `${copy.fEvery} ${rule.everyMinutes}`
    : rule.kind === "daily" ? `${copy.repeatDaily} ${rule.time}` : `${copy.repeatWeekly} ${days(rule.days)} ${rule.time}`;
  return `${when} (${item.timing.timeZone})`;
}

/** The schedules of Code runs: the switch that turns them on, the form, each schedule, and the record of every run. */
export function SchedulePanel({ view, language, models, defaultModel, project, onOpenTask }: {
  view: ScheduleView | undefined; language: Language; models: Model[]; defaultModel: string | undefined; project: string | null; onOpenTask: (id: string) => void;
}) {
  const copy = desktopParallelCopy[language];
  const [understood, setUnderstood] = useState(false);
  const [notice, setNotice] = useState<{ text: string; alert: boolean } | null>(null);
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [repeat, setRepeat] = useState<Repeat>("daily");
  const [onceAt, setOnceAt] = useState(() => inputValue(Date.now() + 10 * MINUTE, localZone()));
  const [every, setEvery] = useState(60);
  const [time, setTime] = useState("09:00");
  const [days, setDays] = useState<number[]>([1]);
  const [zone, setZone] = useState(localZone);
  const [where, setWhere] = useState<"folder" | "worktree">("folder");
  const [preset, setPreset] = useState<Preset>("readOnly");
  const [cap, setCap] = useState<"standard" | "extended">("standard");
  const [model, setModel] = useState(defaultModel ?? models[0]?.id ?? "");
  useEffect(() => { void window.desktop.schedules({ action: "refresh" }); }, []);
  const chosenModel = model || defaultModel || models[0]?.id || "";

  const dayNames = useMemo(() => [0, 1, 2, 3, 4, 5, 6].map((day) =>
    new Intl.DateTimeFormat(language, { weekday: "short", timeZone: "UTC" }).format(new Date(Date.UTC(2023, 0, 1 + day)))), [language]);

  async function run(command: Parameters<typeof window.desktop.schedules>[0], done?: () => void) {
    try {
      const result = await window.desktop.schedules(command);
      if (result.ok) { setNotice(null); done?.(); } else setNotice({ text: refusalText(copy, result.reason), alert: true });
    } catch { setNotice({ text: copy.refuseInvalid, alert: true }); }
  }

  function edit(item: ScheduleItem | null) {
    setNotice(null);
    if (!item) {
      setEditing("new"); setName(""); setPrompt(""); setRepeat("daily"); setTime("09:00"); setDays([1]); setEvery(60); setWhere("folder"); setPreset("readOnly"); setCap("standard");
      setZone(localZone()); setOnceAt(inputValue(Date.now() + 10 * MINUTE, localZone())); setModel(defaultModel ?? models[0]?.id ?? "");
      return;
    }
    const rule = item.timing.cadence;
    setEditing(item.id); setName(item.name); setPrompt(item.prompt); setRepeat(rule.kind); setZone(item.timing.timeZone); setWhere(item.workspace);
    setPreset(presetOf(item)); setCap(item.limits); setModel(item.model);
    if (rule.kind === "once") setOnceAt(inputValue(rule.at, item.timing.timeZone));
    if (rule.kind === "interval") setEvery(rule.everyMinutes);
    if (rule.kind === "daily" || rule.kind === "weekly") setTime(rule.time);
    if (rule.kind === "weekly") setDays(rule.days);
  }

  function build(): ScheduleInput | null {
    const base = { name, prompt, workspace: preset === "all" ? "worktree" as const : where, ...presets[preset], model: chosenModel, limits: cap };
    if (repeat === "once") {
      const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(onceAt);
      if (!match) return null;
      const at = zonedInstant(zone, Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4]), Number(match[5])) + Number(match[6] ?? 0) * 1000;
      return { ...base, ...(editing && editing !== "new" ? { id: editing } : {}), timing: { cadence: { kind: "once", at }, timeZone: zone } };
    }
    const cadence = repeat === "interval" ? { kind: "interval" as const, everyMinutes: every, anchor: Date.now() }
      : repeat === "daily" ? { kind: "daily" as const, time } : { kind: "weekly" as const, time, days };
    return { ...base, ...(editing && editing !== "new" ? { id: editing } : {}), timing: { cadence, timeZone: zone } };
  }

  if (!view) return <p role="status">…</p>;
  const liveRuns = view.runs;
  return <section aria-label={copy.scheduleHeading} data-testid="schedule-panel">
    <h3>{copy.scheduleHeading}</h3>
    {!view.enabled ? <div className="schedule-warning" data-testid="schedule-off">
      <p>{copy.scheduleOff}</p>
      <p role="note" data-testid="schedule-warning">{fill(copy.scheduleWarning, { minutes: view.approvalWaitMinutes })}</p>
      <label className="inline"><input type="checkbox" checked={understood} onChange={(event) => setUnderstood(event.currentTarget.checked)} />{copy.scheduleUnderstand}</label>
      <button type="button" className="primary" disabled={!understood} data-testid="schedule-turn-on"
        onClick={() => void run({ action: "enable", enabled: true, acknowledged: true })}>{copy.scheduleTurnOn}</button>
    </div> : <p>
      <button type="button" className="soft" data-testid="schedule-turn-off" onClick={() => void run({ action: "enable", enabled: false }, () => setUnderstood(false))}>{copy.scheduleTurnOff}</button>
      {" "}<button type="button" className="soft" data-testid="schedule-new" onClick={() => edit(null)}>{copy.scheduleNew}</button>
    </p>}
    {notice && <p className="activity-notice" role={notice.alert ? "alert" : "status"}>{notice.text}</p>}

    {editing && <form className="schedule-form" data-testid="schedule-form" onSubmit={(event) => {
      event.preventDefault();
      const input = build();
      if (!input) { setNotice({ text: copy.refuseInvalid, alert: true }); return; }
      void run({ action: "save", input }, () => setEditing(null));
    }}>
      <p className="activity-hint">{copy.project}: <code>{project ?? "—"}</code></p>
      <div className="grid">
        <label>{copy.fName}<input value={name} maxLength={80} required onChange={(event) => setName(event.currentTarget.value)} /></label>
        <label>{copy.fModel}<select value={chosenModel} onChange={(event) => setModel(event.currentTarget.value)}>
          {models.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}</select></label>
      </div>
      <label>{copy.fPrompt}<textarea value={prompt} required maxLength={24000} onChange={(event) => setPrompt(event.currentTarget.value)} /></label>
      <div className="grid">
        <label>{copy.fRepeat}<select aria-label={copy.fRepeat} value={repeat} onChange={(event) => setRepeat(event.currentTarget.value as Repeat)}>
          <option value="once">{copy.repeatOnce}</option><option value="interval">{copy.repeatInterval}</option>
          <option value="daily">{copy.repeatDaily}</option><option value="weekly">{copy.repeatWeekly}</option></select></label>
        {repeat === "once" && <label>{copy.fWhen}<input type="datetime-local" step={1} value={onceAt} onChange={(event) => setOnceAt(event.currentTarget.value)} /></label>}
        {repeat === "interval" && <label>{copy.fEvery}<input type="number" min={5} max={10080} value={every} onChange={(event) => setEvery(Number(event.currentTarget.value))} /></label>}
        {(repeat === "daily" || repeat === "weekly") && <label>{copy.fTime}<input type="time" value={time} onChange={(event) => setTime(event.currentTarget.value)} /></label>}
        <label>{copy.fZone}<input value={zone} maxLength={64} onChange={(event) => setZone(event.currentTarget.value)} /></label>
      </div>
      {repeat === "weekly" && <fieldset aria-label={copy.fDays}>
        {dayNames.map((label, day) => <label key={day} className="inline"><input type="checkbox" checked={days.includes(day)}
          onChange={(event) => setDays(event.currentTarget.checked ? [...days, day] : days.filter((value) => value !== day))} />{label}</label>)}
      </fieldset>}
      <div className="grid">
        <label>{copy.fMode}<select aria-label={copy.fMode} value={preset} onChange={(event) => setPreset(event.currentTarget.value as Preset)}>
          <option value="readOnly">{copy.presetReadOnly}</option><option value="ask">{copy.presetAsk}</option>
          <option value="review">{copy.presetReview}</option><option value="all">{copy.presetAll}</option></select></label>
        <label>{copy.fWhere}<select aria-label={copy.fWhere} value={preset === "all" ? "worktree" : where} disabled={preset === "all"}
          onChange={(event) => setWhere(event.currentTarget.value as "folder" | "worktree")}>
          <option value="folder">{copy.whereFolder}</option><option value="worktree">{copy.whereWorktree}</option></select></label>
        <label>{copy.fCap}<select aria-label={copy.fCap} value={cap} onChange={(event) => setCap(event.currentTarget.value as "standard" | "extended")}>
          <option value="standard">{fill(copy.capStandard, { count: REQUESTS.standard })}</option>
          <option value="extended">{fill(copy.capExtended, { count: REQUESTS.extended })}</option></select></label>
      </div>
      {preset === "all" && <p className="activity-hint" role="note">{copy.allowAllNote} {view.sandboxEnforced ? copy.sandboxOn : copy.sandboxOff}</p>}
      <p>
        <button type="submit" className="primary" data-testid="schedule-save">{copy.scheduleSave}</button>{" "}
        <button type="button" className="soft" onClick={() => setEditing(null)}>{copy.scheduleCancel}</button>
      </p>
    </form>}

    {!!view.items.length && <ul className="schedule-list">
      {view.items.map((item) => <li key={item.id} className="schedule-item" data-testid="schedule-item" data-enabled={item.enabled} data-running={item.running}>
        <strong>{item.name}</strong>
        <small>{describe(copy, item, language)}</small>
        <small>{copy.project}: <code>{item.project}</code></small>
        <small>
          {item.disabledBy === "failures" ? fill(copy.disabledByFailures, { count: view.failureLimit })
            : item.disabledBy === "finished" ? copy.disabledFinished
            : item.running ? copy.runningNow
            : `${copy.nextRun}: ${item.nextRun === null ? copy.noNextRun : timeText(item.nextRun, language)}`}
          {item.failures > 0 && !item.disabledBy ? ` · ${fill(copy.failuresInRow, { count: item.failures })}` : ""}
        </small>
        <span className="row-actions">
          <button type="button" className="soft" onClick={() => edit(item)}><Pencil size={13} /> {copy.scheduleEdit}</button>
          <button type="button" className="soft" onClick={() => void run({ action: "toggle", id: item.id, enabled: !item.enabled })}>{item.enabled ? copy.scheduleDisable : copy.scheduleEnable}</button>
          <button type="button" className="soft" disabled={!view.enabled || item.running} data-testid="schedule-run-now" onClick={() => void run({ action: "run-now", id: item.id })}><Play size={13} /> {copy.scheduleRunNow}</button>
          <button type="button" className="soft" disabled={item.running} onClick={() => void run({ action: "delete", id: item.id })}><Trash2 size={13} /> {copy.scheduleDelete}</button>
        </span>
      </li>)}
    </ul>}

    <h3>{copy.runsHeading}</h3>
    {!liveRuns.length ? <p className="activity-hint">{copy.runsEmpty}</p> : <ul className="run-list" data-testid="run-list">
      {liveRuns.slice(0, 50).map((entry: ScheduleRun) => <li key={entry.id} data-testid="run-row" data-status={entry.status}>
        <span><strong>{entry.name}</strong> · <span className="run-status">{runStatus(copy, entry)}</span></span>
        <span>{copy.runScheduled} {timeText(entry.scheduledFor, language)} · {copy.runStarted} {timeText(entry.startedAt, language)} · {copy.runEnded} {timeText(entry.finishedAt, language)}</span>
        {(entry.files.count > 0 || entry.status === "completed") && <span>{fill(copy.runFiles, { count: entry.files.count })}{entry.files.paths.length ? `: ${entry.files.paths.join(", ")}` : ""}</span>}
        {entry.taskId && (entry.project === project
          ? <span><button type="button" className="soft" data-testid="run-open" onClick={() => onOpenTask(entry.taskId!)}>{copy.runOpen}</button></span>
          : <span className="activity-hint">{copy.runOpenElsewhere}</span>)}
      </li>)}
    </ul>}
  </section>;
}
