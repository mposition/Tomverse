import type { Language } from "../../../../lib/language";
import { desktopCodeEngineCopy } from "../../../../locales/desktopCodeEngine";
import { codeLimitProfile, type CodeLimitProfile, type Task } from "../contract";

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

export function CodeEngineBar({ task, language }: { task: Task; language: Language }) {
  const copy = desktopCodeEngineCopy[language];
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
    </div>
    {last && <small>
      <strong>{last.met ? copy.goalVerified : copy.goalPending}</strong>{last.summary ? ` · ${last.summary}` : ""}
      {!last.met && last.next ? ` · ${copy.goalNext.replace("{action}", last.next)}` : ""}
    </small>}
  </div>;
}
