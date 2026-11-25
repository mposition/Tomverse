import { useState } from "react";
import type { Language } from "../../../../lib/language";
import { desktopCodeEngineCopy } from "../../../../locales/desktopCodeEngine";
import { desktopShellCopy } from "../../../../locales/desktopShell";
import { codeLimitProfile, type CodeLimitProfile, type CompactHistoryResult, type Task } from "../contract";

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

/** The levels to offer for a model: default first, then the ones its catalog entry names, and a level already chosen so the choice stays visible. */
export function effortOptions(offered: readonly string[] | undefined, chosen: string): string[] {
  return [...new Set(["default", ...(offered ?? []), chosen])];
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
  const [compaction, setCompaction] = useState<"working" | CompactHistoryResult | null>(null);
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
