import { useState, type FormEvent } from "react";
import { ArrowDown, ArrowUp, Pencil, X } from "lucide-react";
import type { Language } from "../../../../lib/language";
import { desktopCodeEngineCopy } from "../../../../locales/desktopCodeEngine";
import { desktopShellCopy } from "../../../../locales/desktopShell";
import { MAX_CODE_PROMPT_CHARACTERS, codeLimitProfile, type CodeLimitProfile, type CompactHistoryResult, type QueueOperation, type Task } from "../contract";

/** A reasoning level for display: the named ones are translated, any other id the catalog reports is shown as it is. */
export function effortLabel(language: Language, effort: string): string {
  const shell = desktopShellCopy[language];
  const engine = desktopCodeEngineCopy[language];
  switch (effort) {
    case "default": return shell.defaultEffort;
    case "low": return shell.lowEffort;
    case "high": return shell.highEffort;
    case "minimal": return engine.effortMinimal;
    case "medium": return engine.effortMedium;
    case "xhigh": return engine.effortXhigh;
    case "max": return engine.effortMax;
    default: return effort;
  }
}

const effortRank = ["default", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * The levels to offer: default, low and high as always (a model that does not name them uses its default), then the levels its
 * catalog entry adds, and a level already chosen so the choice stays visible. Ordered from least to most effort.
 */
export function effortOptions(offered: readonly string[] | undefined, chosen: string): string[] {
  const position = (id: string) => effortRank.includes(id) ? effortRank.indexOf(id) : effortRank.length;
  return [...new Set(["default", "low", "high", ...(offered ?? []), chosen])]
    .sort((left, right) => position(left) - position(right) || left.localeCompare(right));
}

const storageKey = "tomverse.desktop.codeEngine";

/** What the person chose for new Code tasks: limit profile and goal mode. Kept in this window only. */
export type CodeEnginePreference = { limits: CodeLimitProfile; goal: boolean };
export const defaultCodeEngine: CodeEnginePreference = { limits: "standard", goal: false };

export function readCodeEnginePreference(): CodeEnginePreference {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) ?? "null") as { limits?: unknown; goal?: unknown } | null;
    const limits = codeLimitProfile.safeParse(saved?.limits);
    return { limits: limits.success ? limits.data : "standard", goal: saved?.goal === true };
  } catch {
    return defaultCodeEngine;
  }
}

export function writeCodeEnginePreference(value: CodeEnginePreference) {
  try { localStorage.setItem(storageKey, JSON.stringify(value)); }
  catch { /* The choice still applies until the window closes. */ }
}

const compactableStatuses: Task["status"][] = ["completed", "stopped", "blocked", "clarification", "failed"];

export function CodeEngineBar({ task, language, idle }: { task: Task; language: Language; idle: boolean }) {
  const copy = desktopCodeEngineCopy[language];
  const [attempt, setAttempt] = useState<{ taskId: string | null; result: "working" | CompactHistoryResult } | null>(null);
  const compaction = attempt?.taskId === task.id ? attempt.result : null;
  const setCompaction = (result: "working" | CompactHistoryResult) => setAttempt({ taskId: task.id, result });
  const canCompact = idle && !!task.id && !!task.context && task.savedLocally !== false && task.execution?.executionMode === "tomverse_api" &&
    !task.continuation && !task.cliContinuation && compactableStatuses.includes(task.status);
  async function compact() {
    if (!task.id) return;
    setCompaction("working");
    try { setCompaction(await window.desktop.compactTask(task.id)); }
    catch { setCompaction("failed"); }
  }
  const { limits, goal, context } = task;
  const last = goal?.last;
  if (!limits && !goal && !context) return null;
  const percent = context ? Math.min(100, Math.round(context.tokens / Math.max(1, context.window) * 100)) : 0;
  return <div className="code-engine">
    <div role="status" aria-live="polite">
      {limits && <span>{copy.limitsChip.replace("{profile}", limits === "unlimited" ? copy.limitsUnlimitedShort : copy.limitsExtendedShort)}</span>}
      {goal && <span>{copy.goalChip.replace("{count}", String(goal.continuations)).replace("{max}", String(goal.maxContinuations))}</span>}
      {context && <span>{copy.contextUsage.replace("{percent}", String(percent))
        .replace("{used}", context.tokens.toLocaleString(language)).replace("{window}", context.window.toLocaleString(language))}</span>}
      {canCompact && <button className="soft" type="button" disabled={compaction === "working"} onClick={() => void compact()}>
        {compaction === "working" ? copy.compacting : copy.compact}</button>}
    </div>
    {compaction && compaction !== "working" && <small role="status">
      {compaction === "compacted" ? copy.compacted : compaction === "nothing" ? copy.compactNothing : copy.compactFailed}</small>}
    {last && <small>
      <strong>{last.met ? copy.goalVerified : copy.goalPending}</strong>{last.summary ? ` · ${last.summary}` : ""}
      {!last.met && last.next ? ` · ${copy.goalNext.replace("{action}", last.next)}` : ""}
    </small>}
  </div>;
}

/** Messages held for after the current turn: edit, reorder or remove them while the task runs. */
export function QueuePanel({ task, language, live }: { task: Task; language: Language; live: boolean }) {
  const copy = desktopCodeEngineCopy[language];
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [failed, setFailed] = useState(false);
  const queued = task.queued ?? [];
  if (!queued.length || !task.id) return null;
  const taskId = task.id;
  async function run(operation: QueueOperation) {
    try {
      const done = await window.desktop.queueMessage(taskId, operation);
      setFailed(!done);
      return done;
    } catch {
      setFailed(true);
      return false;
    }
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (editing?.text.trim() && await run({ kind: "edit", itemId: editing.id, text: editing.text })) setEditing(null);
  }
  const heading = copy.queueHeading.replace("{count}", String(queued.length));
  return <section className="code-queue" aria-label={heading}>
    <strong>{heading}</strong>
    <small>{live ? copy.queueHint : copy.queueLeft}</small>
    <ol>{queued.map((item, index) => <li key={item.id}>
      {editing?.id === item.id
        ? <form onSubmit={(event) => void save(event)}>
          <textarea aria-label={copy.queueEdit} value={editing.text} maxLength={MAX_CODE_PROMPT_CHARACTERS}
            onChange={(event) => setEditing({ id: item.id, text: event.currentTarget.value })} />
          <button className="soft" type="submit" disabled={!editing.text.trim()}>{copy.queueSave}</button>
          <button className="soft" type="button" onClick={() => setEditing(null)}>{copy.queueCancel}</button>
        </form>
        : <>
          <span>{item.text}</span>
          {live && <span className="code-queue-actions">
            <button className="icon" type="button" aria-label={copy.queueUp} title={copy.queueUp} disabled={index === 0}
              onClick={() => void run({ kind: "move", itemId: item.id, direction: -1 })}><ArrowUp size={13} /></button>
            <button className="icon" type="button" aria-label={copy.queueDown} title={copy.queueDown} disabled={index === queued.length - 1}
              onClick={() => void run({ kind: "move", itemId: item.id, direction: 1 })}><ArrowDown size={13} /></button>
            <button className="icon" type="button" aria-label={copy.queueEdit} title={copy.queueEdit}
              onClick={() => setEditing({ id: item.id, text: item.text })}><Pencil size={13} /></button>
            <button className="icon" type="button" aria-label={copy.queueRemove} title={copy.queueRemove}
              onClick={() => void run({ kind: "remove", itemId: item.id })}><X size={13} /></button>
          </span>}
        </>}
    </li>)}</ol>
    {failed && <small role="alert">{copy.queueFailed}</small>}
  </section>;
}
