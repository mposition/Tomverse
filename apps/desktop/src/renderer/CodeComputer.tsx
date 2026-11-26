import { useCallback, useEffect, useState } from "react";
import type { Language } from "../../../../lib/language";
import { desktopCodeComputerCopy } from "../../../../locales/desktopCodeComputer";
import type { ComputerState, ComputerWindowRow } from "../computer-contract";
import "./code-computer.css";

/** The person's state of the computer tools, from the main process: the switch, the chosen window and who holds control. */
export function useComputerState() {
  const [state, setState] = useState<ComputerState | null>(null);
  useEffect(() => {
    let live = true;
    void window.desktop.codeComputer({ type: "state" }).then((result) => { if (live) setState((previous) => previous ?? result.state); }, () => undefined);
    const unsubscribe = window.desktop.subscribeCodeComputer((next) => { if (live) setState(next); });
    return () => { live = false; unsubscribe(); };
  }, []);
  return [state, setState] as const;
}

const fill = (text: string, values: Record<string, string>) => text.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? "");

/**
 * Code: choose the one window the agent may see and operate, see that it is working, and take control. Nothing shows while the
 * switch (Settings > Execution and limits) is off or the system has no implementation.
 */
export function CodeComputer({ language }: { language: Language }) {
  const copy = desktopCodeComputerCopy[language];
  const [state, setState] = useComputerState();
  const [windows, setWindows] = useState<ComputerWindowRow[] | null>(null);
  const [hidden, setHidden] = useState(0);
  const [failed, setFailed] = useState(false);
  const run = useCallback(async (command: Parameters<typeof window.desktop.codeComputer>[0]) => {
    try {
      const result = await window.desktop.codeComputer(command);
      setState(result.state);
      setFailed(false);
      return result;
    } catch { setFailed(true); return null; }
  }, [setState]);
  const load = useCallback(async () => {
    const result = await run({ type: "list" });
    if (result?.windows) { setWindows(result.windows); setHidden(result.hidden ?? 0); }
  }, [run]);
  if (!state?.enabled || !state.supported) return null;
  const choosing = windows !== null;
  const notice = state.notice === "user-input" ? copy.stoppedInput : state.notice === "window-closed" ? copy.closed
    : state.notice === "stop-key-unavailable" ? copy.noStopKey : null;
  return <section className="code-computer" aria-label={copy.title} data-testid="code-computer" data-control={state.control}>
    <div className="code-computer-heading">
      <strong>{copy.title}</strong>
      {state.selected
        ? <span role="status" data-state={state.control}>{state.control === "working" ? copy.working : state.control === "stopped" ? copy.stopped : copy.idle}</span>
        : <span>{copy.listHint}</span>}
    </div>
    {state.selected && <p className="code-computer-window" data-testid="code-computer-selected">
      {fill(copy.using, { window: `${state.selected.title} (${state.selected.app})` })}</p>}
    {notice && <p role="alert" className="code-computer-notice">{notice}</p>}
    {failed && <p role="alert" className="code-computer-notice">{copy.failed}</p>}
    <div className="code-computer-actions">
      {state.selected && (state.control === "stopped"
        ? <button type="button" className="soft" onClick={() => void run({ type: "give" })}>{copy.give}</button>
        : <button type="button" className="soft" onClick={() => void run({ type: "take" })}>{copy.take}</button>)}
      <button type="button" className="soft" onClick={() => void load()}>{state.selected ? copy.change : copy.choose}</button>
      {state.selected && <button type="button" className="soft" onClick={() => { setWindows(null); void run({ type: "revoke" }); }}>{copy.revoke}</button>}
      {state.stopKey && state.selected && <small>{fill(copy.stopKey, { key: state.stopKey })}</small>}
    </div>
    {choosing && <div className="code-computer-list" role="group" aria-label={copy.choose}>
      <div className="code-computer-actions">
        <button type="button" className="soft" onClick={() => void load()}>{copy.refresh}</button>
        <button type="button" className="soft" onClick={() => setWindows(null)}>{copy.confirmNo}</button>
      </div>
      {windows.length === 0 && <p>{copy.none}</p>}
      <ul>{windows.map((entry) => <li key={entry.id}>
        <button type="button" className="soft" data-testid="code-computer-window" onClick={() => void run({ type: "select", id: entry.id }).then((result) => { if (result) setWindows(null); })}>
          <strong>{entry.title}</strong> <span>{entry.app}</span></button>
      </li>)}</ul>
      {hidden > 0 && <small>{fill(copy.hidden, { count: String(hidden) })}</small>}
    </div>}
  </section>;
}
